import { execFile } from "child_process";
import { NextResponse } from "next/server";
import { promisify } from "util";
import { loadReview, saveReview } from "@/lib/review-store";
import { discoverSessions } from "@/lib/discovery";
import { readFullConversation, linesToConversation } from "@/lib/session-reader";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

/**
 * GET — Queue status: what's processing, how many pending, session status.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	// Single pass over comments to gather all counts
	let processing: typeof review.comments[number] | null = null;
	let pendingCount = 0;
	let completedCount = 0;
	for (const c of review.comments) {
		if (c.status === "processing" || c.status === "sending") processing = c;
		else if (c.status === "pending") pendingCount++;
		else if (c.status === "answered" || c.status === "resolved") completedCount++;
	}

	// Check the Claude session status
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	const sessionStatus = session?.status ?? "finished";

	// Try to capture Claude's response for the processing comment.
	// Only capture when the session has settled (idle/waiting/errored) so we
	// don't grab an intermediate "Let me check..." while Claude is still working.
	if (processing && processing.status === "processing") {
		const sessionSettled = sessionStatus === "idle" || sessionStatus === "waiting" || sessionStatus === "errored";

		if (sessionSettled) {
			let response: string | null = null;

			if (session?.jsonlPath) {
				try {
					const lines = await readFullConversation(session.jsonlPath);
					const conversation = linesToConversation(lines);
					// Match by unique comment ID first, fall back to file signature
					const commentTag = `[id:${processing.id}]`;
					const lineRef = processing.endLine ? `lines ${processing.line}-${processing.endLine}` : `line ${processing.line}`;
					const fileSignature = `File: ${processing.filePath} (${lineRef})`;
					const promptIdx = conversation.findLastIndex(
						(m) => m.type === "user" && (m.text?.includes(commentTag) || m.text?.includes(fileSignature)),
					);
					if (promptIdx >= 0) {
						// Take the LAST assistant text — this matches what the terminal displays.
						// Earlier assistant messages are intermediate (before tool calls).
						let lastText: string | null = null;
						for (let i = promptIdx + 1; i < conversation.length; i++) {
							const m = conversation[i];
							if (m.type === "user") break;
							if (m.type === "assistant" && m.text) lastText = m.text;
						}
						if (lastText) response = lastText;
					}
				} catch {
					// ignore — will retry on next poll
				}
			}

			if (response) {
				processing.status = "answered";
				processing.response = response;
				await saveReview(sessionId, review);

				// Auto-post reply to GitHub if this was a GitHub thread reply
				if (processing.githubThreadId && review.workingDirectory) {
					postReplyToGitHub(processing.githubThreadId, processing.content, response, review.workingDirectory).catch((err) =>
						console.error("Failed to auto-post GitHub reply:", err),
					);
				}

				return NextResponse.json({
					processingId: null,
					pendingCount,
					completedCount: completedCount + 1,
					sessionStatus,
					justResolved: processing.id,
				});
			}

			// Session settled but no response — force-unblock on error/timeout
			const processingAge = Date.now() - new Date(processing.createdAt).getTime();
			if (sessionStatus === "errored" || processingAge > 120_000) {
				processing.status = "answered";
				processing.response = sessionStatus === "errored"
					? "The session encountered an error while processing this comment."
					: null;
				await saveReview(sessionId, review);

				return NextResponse.json({
					processingId: null,
					pendingCount,
					completedCount: completedCount + 1,
					sessionStatus,
					justResolved: processing.id,
				});
			}
		}
	}

	return NextResponse.json({
		processingId: processing?.id ?? null,
		pendingCount,
		completedCount,
		sessionStatus,
		justResolved: null,
	});
}

/**
 * POST — Send the next pending comment to the Claude session.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	// Single pass: find processing and next pending
	let alreadyProcessing: typeof review.comments[number] | null = null;
	let nextPending: typeof review.comments[number] | null = null;
	for (const c of review.comments) {
		if (c.status === "processing" || c.status === "sending") {
			alreadyProcessing = c;
			break;
		}
		if (c.status === "pending" && !nextPending) {
			nextPending = c;
		}
	}

	if (alreadyProcessing) {
		return NextResponse.json({ sent: false, reason: "already-processing", commentId: alreadyProcessing.id });
	}

	// Find the Claude session
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) {
		return NextResponse.json({ sent: false, reason: "session-not-found" });
	}

	if (session.status !== "idle" && session.status !== "waiting") {
		return NextResponse.json({ sent: false, reason: "session-busy", sessionStatus: session.status });
	}

	if (!nextPending) {
		return NextResponse.json({ sent: false, reason: "no-pending-comments" });
	}

	const prompt = formatReviewPrompt(nextPending.id, nextPending.filePath, nextPending.line, nextPending.anchorSnippet, nextPending.content, nextPending.endLine, nextPending.githubThreadId);

	try {
		const res = await fetch(`http://localhost:3200/api/actions/open`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "send-message",
				path: review.workingDirectory,
				pid: session.pid,
				message: prompt,
			}),
		});

		if (!res.ok) {
			return NextResponse.json({ sent: false, reason: "send-failed" });
		}

		nextPending.status = "processing";
		review.queueHead = review.comments.indexOf(nextPending) + 1;
		await saveReview(sessionId, review);

		return NextResponse.json({ sent: true, commentId: nextPending.id });
	} catch (err) {
		console.error("Failed to send review comment:", err);
		return NextResponse.json({ sent: false, reason: "send-error" });
	}
}

function formatReviewPrompt(commentId: string, filePath: string, line: number, anchorSnippet: string, content: string, endLine?: number, githubThreadId?: string): string {
	const lineRef = endLine ? `lines ${line}-${endLine}` : `line ${line}`;
	const tag = githubThreadId ? "[GitHub PR Review Reply]" : "[Code Review Comment]";
	let prompt = `${tag} [id:${commentId}]\nFile: ${filePath} (${lineRef})`;
	if (githubThreadId && anchorSnippet) {
		// anchorSnippet contains the GitHub comment: "@author: body"
		prompt += `\n\nGitHub PR review comment:\n${anchorSnippet}`;
	} else if (anchorSnippet) {
		prompt += `\n\nContext:\n\`\`\`\n${anchorSnippet}\n\`\`\``;
	}
	if (githubThreadId) {
		prompt += `\n\nThe user's reply to the above GitHub comment: "${content}"`;
	} else {
		prompt += `\n\nComment: "${content}"`;
	}
	prompt += `\n\nAddress this review comment. Your final text response will be shown inline in the code review UI, so:`;
	prompt += `\n- If it's a question: answer it directly and concisely.`;
	prompt += `\n- If it requires a code change: make the fix, then reply with the file path, line number, and a brief explanation of what you changed and why.`;
	prompt += `\n- Keep your reply short (2-4 sentences max). No markdown headers or bullet lists.`;
	return prompt;
}

async function postReplyToGitHub(threadId: string, userContent: string, claudeResponse: string, cwd: string): Promise<void> {
	// Post user's reply
	const userMutation = `mutation {
		addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: "${threadId}", body: ${JSON.stringify(userContent)} }) {
			comment { id }
		}
	}`;
	await execFileAsync("gh", ["api", "graphql", "-f", `query=${userMutation}`], { cwd, timeout: 15000 });

	// Post Claude's response as a separate reply
	if (claudeResponse) {
		const claudeBody = `🤖 *Claude's response:*\n\n${claudeResponse}`;
		const claudeMutation = `mutation {
			addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: "${threadId}", body: ${JSON.stringify(claudeBody)} }) {
				comment { id }
			}
		}`;
		await execFileAsync("gh", ["api", "graphql", "-f", `query=${claudeMutation}`], { cwd, timeout: 15000 });
	}
}
