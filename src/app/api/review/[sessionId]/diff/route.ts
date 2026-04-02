import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getFullDiff, getDiffStat } from "@/lib/review-diff";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found. Initialize it first via GET /api/review/[sessionId]" }, { status: 404 });
	}

	const [diff, diffStat] = await Promise.all([
		getFullDiff(review.workingDirectory, review.mergeBase),
		getDiffStat(review.workingDirectory, review.mergeBase),
	]);

	return NextResponse.json({ diff, diffStat });
}
