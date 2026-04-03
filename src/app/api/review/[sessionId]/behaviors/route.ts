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
			const sentAtTag = cached.warnings.find((w) => w.startsWith("__sentAt__:"));
			const sentAt = sentAtTag ? parseInt(sentAtTag.split(":")[1], 10) : 0;

			// Check for timeout (300 seconds — Claude may do many tool calls)
			if (sentAt && Date.now() - sentAt > 300_000) {
				const timedOut = { ...cached, warnings: ["Analysis timed out. Try again."] };
				await saveBehaviorAnalysis(sessionId, timedOut);
				return NextResponse.json({ ...timedOut, status: "error", stale: false });
			}

			// Try to find Claude's response in the JSONL
			// Look for ANY behavior analysis response, not just the one matching our ID
			const response = await pollForResponse(sessionId);
			if (response) {
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
 *
 * Unlike review comments (which get a single text response), behavior analysis
 * prompts trigger Claude to make tool calls (git diff, read files) before
 * responding with JSON. The JSONL contains many interleaved user (tool_result)
 * and assistant (tool_use/text) messages. We need to find the LAST assistant
 * text block that contains the JSON response, scanning past all the tool calls.
 */
async function pollForResponse(sessionId: string): Promise<string | null> {
	try {
		const sessions = await discoverSessions();
		const session = sessions.find((s) => s.id === sessionId);
		if (!session?.jsonlPath) return null;

		const lines = await readFullConversation(session.jsonlPath);
		const conversation = linesToConversation(lines);

		// Find the LAST behavior analysis prompt (any ID)
		const promptIdx = conversation.findLastIndex(
			(m) => m.type === "user" && m.text?.includes("[Behavior Analysis]"),
		);

		if (promptIdx < 0) return null;

		// Scan ALL messages after the prompt for the last assistant text with JSON.
		// Don't stop at user messages — Claude makes tool calls (Bash, Read) which
		// create interleaved user (tool_result) and assistant (tool_use) entries.
		let lastJsonText: string | null = null;

		for (let i = promptIdx + 1; i < conversation.length; i++) {
			const m = conversation[i];
			if (m.type === "assistant" && m.text) {
				if (m.text.includes('"flows"')) {
					lastJsonText = m.text;
				}
			}
		}

		return lastJsonText;
	} catch {
		return null;
	}
}
