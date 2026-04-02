import { NextResponse } from "next/server";
import { loadReview, saveReview } from "@/lib/review-store";
import { discoverSessions } from "@/lib/discovery";

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
		else if (c.status === "resolved") completedCount++;
	}

	// Check the Claude session status
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	const sessionStatus = session?.status ?? "finished";

	// If session went idle and there's a processing comment, mark it resolved
	if (processing && (sessionStatus === "idle" || sessionStatus === "waiting") && processing.status === "processing") {
		processing.status = "resolved";
		processing.resolvedAt = new Date().toISOString();
		await saveReview(sessionId, review);

		return NextResponse.json({
			processingId: null,
			pendingCount,
			completedCount: completedCount + 1,
			sessionStatus,
			justResolved: processing.id,
		});
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
	prompt += "\n\nPlease address this review comment by making the necessary code changes. After making changes, briefly explain what you did.";
	return prompt;
}
