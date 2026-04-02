import { NextResponse } from "next/server";
import { loadReview } from "@/lib/review-store";
import { getFullDiff, getDiffStat, getCommitDiff, getCommittedDiff, getUncommittedDiff, getBranchDiff } from "@/lib/review-diff";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found. Initialize it first via GET /api/review/[sessionId]" }, { status: 404 });
	}

	const { searchParams } = new URL(request.url);
	const commit = searchParams.get("commit");
	const cwd = review.workingDirectory;

	if (commit === "committed") {
		const diff = await getCommittedDiff(cwd, review.mergeBase);
		return NextResponse.json({ diff, diffStat: "" });
	}

	if (commit === "branch") {
		const diff = await getBranchDiff(cwd, review.mergeBase);
		return NextResponse.json({ diff, diffStat: "" });
	}

	if (commit === "uncommitted") {
		const diff = await getUncommittedDiff(cwd);
		return NextResponse.json({ diff, diffStat: "" });
	}

	if (commit && commit !== "all") {
		const diff = await getCommitDiff(cwd, commit);
		return NextResponse.json({ diff, diffStat: "" });
	}

	// Full diff (all commits + working tree)
	const [diff, diffStat] = await Promise.all([
		getFullDiff(cwd, review.mergeBase),
		getDiffStat(cwd, review.mergeBase),
	]);

	return NextResponse.json({ diff, diffStat });
}
