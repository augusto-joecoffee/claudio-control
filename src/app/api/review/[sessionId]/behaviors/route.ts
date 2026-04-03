import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint } from "@/lib/review-diff";
import { loadBehaviorAnalysis, saveBehaviorAnalysis } from "@/lib/behavior-store";
import { discoverSessions } from "@/lib/discovery";
import { readFullConversation, linesToConversation } from "@/lib/session-reader";
import { parseClaudeResponse } from "@/lib/behavior/response-parser";

export const dynamic = "force-dynamic";

/**
 * GET: Return cached behavior analysis, or check if a processing analysis
 * has completed by polling the Claude session's JSONL.
 *
 * Returns:
 * - Complete analysis if cached and fingerprint matches
 * - { status: "pending" } if no analysis exists yet (frontend should POST /analyze)
 * - { status: "processing" } if analysis is in progress
 * - Complete analysis if JSONL response was just found and parsed
 */
export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json(
			{ error: "Review not found. Initialize it first via GET /api/review/[sessionId]" },
			{ status: 404 },
		);
	}

	const cwd = review.workingDirectory;
	const fingerprint = await getDiffFingerprint(cwd, review.mergeBase);

	// Check cache
	const cached = await loadBehaviorAnalysis(sessionId);

	// If cached with matching fingerprint and NOT processing → return it
	if (cached && cached.diffFingerprint === fingerprint) {
		const isProcessing = cached.warnings.includes("__processing__");

		if (!isProcessing && cached.behaviors.length > 0) {
			return NextResponse.json({ ...cached, status: "complete", stale: false });
		}

		if (isProcessing) {
			// Analysis is in progress — try to read the response from JSONL
			const analysisIdTag = cached.warnings.find((w) => w.startsWith("__analysisId__:"));
			const sentAtTag = cached.warnings.find((w) => w.startsWith("__sentAt__:"));
			const analysisId = analysisIdTag?.split(":").slice(1).join(":") ?? "";
			const sentAt = sentAtTag ? parseInt(sentAtTag.split(":")[1], 10) : 0;

			// Check for timeout (180 seconds)
			if (sentAt && Date.now() - sentAt > 180_000) {
				// Timeout — clear the processing marker
				const timedOut = {
					...cached,
					warnings: ["Analysis timed out. Try again."],
				};
				await saveBehaviorAnalysis(sessionId, timedOut);
				return NextResponse.json({ ...timedOut, status: "error", stale: false });
			}

			// Try to find Claude's response in the JSONL
			const response = await pollForResponse(sessionId, analysisId);
			if (response) {
				// Parse Claude's response into BehaviorAnalysis
				const elapsed = sentAt ? Date.now() - sentAt : 0;
				const analysis = parseClaudeResponse(response, sessionId, fingerprint, elapsed);
				await saveBehaviorAnalysis(sessionId, analysis);
				return NextResponse.json({ ...analysis, status: "complete", stale: false });
			}

			// Still processing
			return NextResponse.json({ status: "processing", stale: false, behaviors: [], orphanedSymbols: [], warnings: [] });
		}
	}

	// No cached analysis or fingerprint mismatch → pending
	return NextResponse.json({ status: "pending", stale: false, behaviors: [], orphanedSymbols: [], warnings: [] });
}

/**
 * Poll the Claude session's JSONL for a response to our behavior analysis prompt.
 * Uses the same [id:xxx] tag matching as the comment queue.
 */
async function pollForResponse(sessionId: string, analysisId: string): Promise<string | null> {
	if (!analysisId) return null;

	try {
		const sessions = await discoverSessions();
		const session = sessions.find((s) => s.id === sessionId);
		if (!session?.jsonlPath) return null;

		const lines = await readFullConversation(session.jsonlPath);
		const conversation = linesToConversation(lines);

		// Find the prompt by its [id:xxx] tag
		const tag = `[id:${analysisId}]`;
		const promptIdx = conversation.findLastIndex(
			(m) => m.type === "user" && m.text?.includes(tag),
		);

		if (promptIdx < 0) return null;

		// Extract the LAST assistant text after the prompt
		let lastText: string | null = null;
		for (let i = promptIdx + 1; i < conversation.length; i++) {
			const m = conversation[i];
			if (m.type === "user") break; // Stop at next user message
			if (m.type === "assistant" && m.text) lastText = m.text;
		}

		return lastText;
	} catch {
		return null;
	}
}
