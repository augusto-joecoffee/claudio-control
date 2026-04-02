import { NextResponse } from "next/server";
import { loadReview, saveReview } from "@/lib/review-store";
import { discoverSessions } from "@/lib/discovery";
import { readFullConversation, linesToConversation } from "@/lib/session-reader";

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

	// If session went idle and there's a processing comment, try to capture Claude's response.
	// Only mark as answered if we find our specific comment in the JSONL with a response after it.
	// The session can briefly go "idle" between tool calls — don't mark answered prematurely.
	if (processing && (sessionStatus === "idle" || sessionStatus === "waiting") && processing.status === "processing") {
		let response: string | null = null;

		if (session?.jsonlPath) {
			try {
				const lines = await readFullConversation(session.jsonlPath);
				const conversation = linesToConversation(lines);
				const promptSignature = `[Code Review Comment]\nFile: ${processing.filePath} (line ${processing.line})`;
				const promptIdx = conversation.findLastIndex(
					(m) => m.type === "user" && m.text?.includes(promptSignature),
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

		// Only mark as answered if we found a real response to THIS comment
		if (response) {
			processing.status = "answered";
			processing.response = response;
			await saveReview(sessionId, review);

			return NextResponse.json({
				processingId: null,
				pendingCount,
				completedCount: completedCount + 1,
				sessionStatus,
				justResolved: processing.id,
			});
		}

		// No response found yet — session may have briefly gone idle between tool calls.
		// Keep status as "processing" and retry on next poll.
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

	const prompt = formatReviewPrompt(nextPending.filePath, nextPending.line, nextPending.anchorSnippet, nextPending.content);

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

function formatReviewPrompt(filePath: string, line: number, anchorSnippet: string, content: string): string {
	let prompt = `[Code Review Comment]\nFile: ${filePath} (line ${line})`;
	if (anchorSnippet) {
		prompt += `\n\nContext:\n\`\`\`\n${anchorSnippet}\n\`\`\``;
	}
	prompt += `\n\nComment: "${content}"`;
	prompt += `\n\nAddress this review comment. Your final text response will be shown inline in the code review UI, so:`;
	prompt += `\n- If it's a question: answer it directly and concisely.`;
	prompt += `\n- If it requires a code change: make the fix, then reply with the file path, line number, and a brief explanation of what you changed and why.`;
	prompt += `\n- Keep your reply short (2-4 sentences max). No markdown headers or bullet lists.`;
	return prompt;
}
