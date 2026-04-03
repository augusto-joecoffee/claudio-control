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

	// Paginate through all review threads (GitHub max is 100 per page)
	const allThreads: unknown[] = [];
	let cursor: string | null = null;

	for (;;) {
		const afterClause = cursor ? `, after: "${cursor}"` : "";
		const query = `query {
			repository(owner: "${parsed.owner}", name: "${parsed.repo}") {
				pullRequest(number: ${parsed.number}) {
					reviewThreads(first: 100${afterClause}) {
						pageInfo { hasNextPage endCursor }
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
							comments(first: 100) {
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
		const page = data?.data?.repository?.pullRequest?.reviewThreads;
		const nodes = page?.nodes ?? [];
		allThreads.push(...nodes);

		if (!page?.pageInfo?.hasNextPage) break;
		cursor = page.pageInfo.endCursor;
	}

	const comments: GitHubReviewComment[] = [];
	for (const thread of allThreads as Record<string, unknown>[]) {
		// Skip resolved threads
		if (thread.isResolved) continue;
		const threadComments = (thread.comments as { nodes: Record<string, unknown>[] })?.nodes;
		if (!threadComments?.length) continue;

		const root = threadComments[0];
		const replies = threadComments.slice(1).map((r) => ({
			id: r.id as string,
			author: (r.author as { login?: string })?.login ?? "unknown",
			body: r.body as string,
			createdAt: r.createdAt as string,
		}));

		// Resolve the best line number — prefer thread.line (new side), fall back to
		// comment.line, then originalLine fields. Skip comments with no usable line.
		const line = (thread.line ?? root.line ?? thread.originalLine ?? root.originalLine ?? 0) as number;
		if (line === 0) continue;

		const startLine = (thread.startLine ?? root.startLine ?? thread.originalStartLine ?? root.originalStartLine ?? undefined) as number | undefined;

		comments.push({
			id: root.id as string,
			threadId: thread.id as string,
			author: (root.author as { login?: string })?.login ?? "unknown",
			body: root.body as string,
			path: (thread.path ?? "") as string,
			line,
			startLine,
			outdated: (thread.isOutdated ?? false) as boolean,
			createdAt: root.createdAt as string,
			url: (root.url ?? "") as string,
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

	// Allow cache busting
	const reqUrl = new URL(_request.url);
	if (reqUrl.searchParams.has("fresh")) {
		cache.delete(review.prUrl);
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
