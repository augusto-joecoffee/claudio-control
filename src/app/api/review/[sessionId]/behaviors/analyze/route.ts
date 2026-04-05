import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint, getFullDiff } from "@/lib/review-diff";
import { saveBehaviorAnalysis } from "@/lib/behavior-store";
import { analyzeBehaviors } from "@/lib/behavior";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const cwd = review.workingDirectory;
	const [fingerprint, rawDiff] = await Promise.all([
		getDiffFingerprint(cwd, review.mergeBase),
		getFullDiff(cwd, review.mergeBase),
	]);

	const analysis = await analyzeBehaviors(sessionId, rawDiff, cwd, fingerprint);
	await saveBehaviorAnalysis(sessionId, analysis);

	return NextResponse.json({
		...analysis,
		status: "complete",
		stale: false,
	});
}
