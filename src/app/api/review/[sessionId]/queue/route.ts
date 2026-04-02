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

	// Check the Claude session status
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	const sessionStatus = session?.status ?? "finished";

	const processing = review.comments.find((c) => c.status === "processing" || c.status === "sending");
	const pendingCount = review.comments.filter((c) => c.status === "pending").length;
	const completedCount = review.comments.filter((c) => c.status === "resolved").length;

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

	// Don't send if there's already a comment being processed
	const alreadyProcessing = review.comments.find((c) => c.status === "processing" || c.status === "sending");
	if (alreadyProcessing) {
		return NextResponse.json({ sent: false, reason: "already-processing", commentId: alreadyProcessing.id });
	}

	// Find the Claude session
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) {
		return NextResponse.json({ sent: false, reason: "session-not-found" });
	}

	// Session must be idle to accept a comment
	if (session.status !== "idle" && session.status !== "waiting") {
		return NextResponse.json({ sent: false, reason: "session-busy", sessionStatus: session.status });
	}

	// Find next pending comment
	const nextComment = review.comments.find((c) => c.status === "pending");
	if (!nextComment) {
		return NextResponse.json({ sent: false, reason: "no-pending-comments" });
	}

	// Format the comment as a prompt for Claude
	const prompt = formatReviewPrompt(nextComment.filePath, nextComment.line, nextComment.anchorSnippet, nextComment.content);

	// Send via the existing send-message mechanism
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

		nextComment.status = "processing";
		review.queueHead = review.comments.indexOf(nextComment) + 1;
		await saveReview(sessionId, review);

		return NextResponse.json({ sent: true, commentId: nextComment.id });
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
