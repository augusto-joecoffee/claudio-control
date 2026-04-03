import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { getDefaultBranch, getMergeBase } from "@/lib/review-diff";
import { getPrBaseBranch } from "@/lib/git-info";
import { loadReview, saveReview } from "@/lib/review-store";
import { discoverSessions } from "@/lib/discovery";
import type { ReviewSession } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;

	// Always look up the live session so we can validate the working directory
	const sessions = await discoverSessions();
	const session = sessions.find((s) => s.id === sessionId);

	const existing = await loadReview(sessionId);
	if (existing) {
		// If the session's working directory changed (e.g. session ID reused across
		// repos, or a worktree moved), the cached review is stale — re-initialize below.
		if (!session || existing.workingDirectory === session.workingDirectory) {
			// Backfill prUrl if missing (reviews created before this field was added)
			if (session?.prUrl && !existing.prUrl) {
				existing.prUrl = session.prUrl;
				await saveReview(sessionId, existing);
			}
			return NextResponse.json(existing);
		}
	}
	if (!session) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}

	const cwd = session.workingDirectory;
	const config = await loadConfig();

	// Prefer the PR's actual base branch (e.g. feature-nx) over the repo default (main).
	// This avoids showing thousands of irrelevant commits when a branch targets
	// an intermediate branch rather than main.
	const branch = session.branch;
	const prBase = branch ? await getPrBaseBranch(cwd, branch) : null;
	const baseBranch = prBase || config.defaultBaseBranch || (await getDefaultBranch(cwd));
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
		prUrl: session.prUrl ?? undefined,
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
