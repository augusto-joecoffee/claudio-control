import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { getDefaultBranch, getMergeBase } from "@/lib/review-diff";
import { loadReview, saveReview } from "@/lib/review-store";
import { discoverSessions } from "@/lib/discovery";
import type { ReviewSession } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;

	// Return existing review if it exists
	const existing = await loadReview(sessionId);
	if (existing) {
		return NextResponse.json(existing);
	}

	// Find the session to get its working directory
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}

	const cwd = session.workingDirectory;
	const config = await loadConfig();
	const baseBranch = config.defaultBaseBranch || (await getDefaultBranch(cwd));
	const mergeBase = await getMergeBase(cwd, baseBranch);

	if (!mergeBase) {
		return NextResponse.json(
			{ error: `No common ancestor found between HEAD and ${baseBranch}. Has this branch diverged from ${baseBranch}?` },
			{ status: 400 },
		);
	}

	const review: ReviewSession = {
		sessionId,
		workingDirectory: cwd,
		baseBranch,
		mergeBase,
		comments: [],
		queueHead: 0,
		createdAt: new Date().toISOString(),
	};

	await saveReview(sessionId, review);
	return NextResponse.json(review);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);
	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const { baseBranch } = (await request.json()) as { baseBranch: string };
	if (!baseBranch) {
		return NextResponse.json({ error: "Missing baseBranch" }, { status: 400 });
	}

	const mergeBase = await getMergeBase(review.workingDirectory, baseBranch);
	if (!mergeBase) {
		return NextResponse.json({ error: `No common ancestor found between HEAD and ${baseBranch}` }, { status: 400 });
	}

	review.baseBranch = baseBranch;
	review.mergeBase = mergeBase;
	await saveReview(sessionId, review);
	return NextResponse.json(review);
}
