import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint } from "@/lib/review-diff";

export const dynamic = "force-dynamic";

/**
 * Lightweight endpoint that returns a fingerprint of the current diff state.
 * Polled frequently by the frontend — only triggers a full diff refresh when
 * the fingerprint changes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const fingerprint = await getDiffFingerprint(review.workingDirectory, review.mergeBase);
	return NextResponse.json({ fingerprint });
}
