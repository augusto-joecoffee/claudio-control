import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint, getFullDiff } from "@/lib/review-diff";
import { loadBehaviorAnalysis, saveBehaviorAnalysis } from "@/lib/behavior-store";
import { analyzeBehaviors } from "@/lib/behavior";

export const dynamic = "force-dynamic";

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
	if (cached && cached.diffFingerprint === fingerprint) {
		return NextResponse.json({ ...cached, stale: false });
	}

	// Run analysis
	const rawDiff = await getFullDiff(cwd, review.mergeBase);
	const analysis = await analyzeBehaviors(sessionId, rawDiff, cwd, fingerprint);
	await saveBehaviorAnalysis(sessionId, analysis);

	return NextResponse.json({
		...analysis,
		stale: false,
	});
}
