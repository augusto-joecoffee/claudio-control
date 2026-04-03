import { execFile } from "child_process";
import { NextResponse } from "next/server";
import { promisify } from "util";
import { loadReview } from "@/lib/review-store";
import type { GitHubReviewComment } from "@/lib/types";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

// Cache per PR URL
const cache = new Map<string, { data: GitHubReviewComment[]; ts: number }>();
const CACHE_TTL_MS = 30_000;

function parsePrNumber(prUrl: string): { owner: string; repo: string; number: number } | null {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!match) return null;
	return { owner: match[1], repo: match[2], number: parseInt(match[3]) };
}

async function fetchGitHubComments(prUrl: string, cwd: string): Promise<GitHubReviewComment[]> {
	const parsed = parsePrNumber(prUrl);
	if (!parsed) return [];

	const query = `query {
		repository(owner: "${parsed.owner}", name: "${parsed.repo}") {
			pullRequest(number: ${parsed.number}) {
				reviewThreads(first: 100) {
					nodes {
						id
						isResolved
						isOutdated
						line
						originalLine
						startLine
						originalStartLine
						path
						diffSide
						comments(first: 50) {
							nodes {
								id
								author { login }
								body
								createdAt
								url
								line
								originalLine
								startLine
								originalStartLine
								}
						}
					}
				}
			}
		}
	}`;

	const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`], {
		cwd,
		timeout: 15000,
	});

	const data = JSON.parse(stdout.trim());
	const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

	const comments: GitHubReviewComment[] = [];
	for (const thread of threads) {
		// Skip resolved threads
		if (thread.isResolved) continue;
		if (!thread.comments?.nodes?.length) continue;

		const root = thread.comments.nodes[0];
		const replies = thread.comments.nodes.slice(1).map((r: { id: string; author?: { login?: string }; body: string; createdAt: string }) => ({
			id: r.id,
			author: r.author?.login ?? "unknown",
			body: r.body,
			createdAt: r.createdAt,
		}));

		// Resolve the best line number — prefer thread.line (new side), fall back to
		// comment.line, then originalLine fields. Skip comments with no usable line.
		const line = thread.line ?? root.line ?? thread.originalLine ?? root.originalLine ?? 0;
		if (line === 0) continue;

		const startLine = thread.startLine ?? root.startLine ?? thread.originalStartLine ?? root.originalStartLine ?? undefined;

		comments.push({
			id: root.id,
			threadId: thread.id,
			author: root.author?.login ?? "unknown",
			body: root.body,
			path: thread.path ?? "",
			line,
			startLine,
			outdated: thread.isOutdated ?? false,
			createdAt: root.createdAt,
			url: root.url ?? "",
			replies,
		});
	}

	return comments;
}

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	if (!review.prUrl) {
		return NextResponse.json({ comments: [] });
	}

	// Check cache
	const now = Date.now();
	const cached = cache.get(review.prUrl);
	if (cached && now - cached.ts < CACHE_TTL_MS) {
		return NextResponse.json({ comments: cached.data });
	}

	try {
		const comments = await fetchGitHubComments(review.prUrl, review.workingDirectory);
		cache.set(review.prUrl, { data: comments, ts: now });
		return NextResponse.json({ comments });
	} catch (error) {
		console.error("Failed to fetch GitHub comments:", error);
		return NextResponse.json({ comments: [] });
	}
}
