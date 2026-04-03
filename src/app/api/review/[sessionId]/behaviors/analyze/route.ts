import { NextResponse } from "next/server";
import { loadReview, saveReview } from "@/lib/review-store";
import { getFullDiff, getDiffFingerprint } from "@/lib/review-diff";
import { loadBehaviorAnalysis, saveBehaviorAnalysis } from "@/lib/behavior-store";
import { discoverSessions } from "@/lib/discovery";
import { formatBehaviorPrompt } from "@/lib/behavior/prompt";
import type { ReviewSession } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST: Trigger behavior analysis by sending a prompt to the Claude session.
 * Reuses the same send-message mechanism as the review comment queue.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const cwd = review.workingDirectory;
	const fingerprint = await getDiffFingerprint(cwd, review.mergeBase);

	// Check if we already have a valid cached analysis
	const cached = await loadBehaviorAnalysis(sessionId);
	if (cached && cached.diffFingerprint === fingerprint && cached.behaviors.length > 0) {
		return NextResponse.json({ status: "complete", message: "Analysis already cached" });
	}

	// Check if analysis is already in progress
	if (cached && cached.diffFingerprint === fingerprint && cached.warnings.includes("__processing__")) {
		return NextResponse.json({ status: "processing", message: "Analysis already in progress" });
	}

	// Find the Claude session
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) {
		return NextResponse.json({ error: "Claude session not found" }, { status: 404 });
	}

	// Get the raw diff
	const rawDiff = await getFullDiff(cwd, review.mergeBase);
	if (!rawDiff) {
		return NextResponse.json({ error: "No diff found" }, { status: 400 });
	}

	// Format the behavior analysis prompt
	const { analysisId, prompt } = formatBehaviorPrompt(rawDiff);

	// Send the prompt to the Claude session via the actions API
	try {
		const res = await fetch("http://localhost:3200/api/actions/open", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "send-message",
				path: cwd,
				pid: session.pid,
				message: prompt,
			}),
		});

		if (!res.ok) {
			return NextResponse.json(
				{ error: `Failed to send prompt to session: ${res.status}` },
				{ status: 500 },
			);
		}
	} catch (e) {
		return NextResponse.json(
			{ error: `Failed to send prompt: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}

	// Save a "processing" marker so the GET endpoint knows to poll JSONL
	const processingAnalysis = {
		sessionId,
		diffFingerprint: fingerprint,
		behaviors: [],
		orphanedSymbols: [],
		analysisTimeMs: 0,
		createdAt: new Date().toISOString(),
		warnings: ["__processing__", `__analysisId__:${analysisId}`, `__sentAt__:${Date.now()}`],
	};
	await saveBehaviorAnalysis(sessionId, processingAnalysis);

	return NextResponse.json({
		status: "processing",
		analysisId,
		message: "Analysis prompt sent to Claude session",
	});
}
