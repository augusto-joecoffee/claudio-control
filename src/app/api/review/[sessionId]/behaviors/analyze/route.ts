import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint } from "@/lib/review-diff";
import { loadBehaviorAnalysis, saveBehaviorAnalysis } from "@/lib/behavior-store";
import { discoverSessions } from "@/lib/discovery";
import { formatBehaviorPrompt } from "@/lib/behavior/prompt";

export const dynamic = "force-dynamic";

/**
 * POST: Trigger behavior analysis by sending a SHORT prompt to the Claude session.
 * The prompt tells Claude to run git diff itself and return structured JSON.
 * We do NOT embed the diff in the prompt (too large for tmux send-keys).
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

	// Format the behavior analysis prompt (short — tells Claude to read the diff itself)
	const { analysisId, prompt } = formatBehaviorPrompt(review.mergeBase);

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
			const errorBody = await res.text().catch(() => "");
			return NextResponse.json(
				{ error: `Failed to send prompt to session: ${res.status} ${errorBody}` },
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
