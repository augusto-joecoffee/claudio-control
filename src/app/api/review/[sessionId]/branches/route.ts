import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getBranches } from "@/lib/review-diff";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const branches = await getBranches(review.workingDirectory);
	return NextResponse.json({ branches });
}
