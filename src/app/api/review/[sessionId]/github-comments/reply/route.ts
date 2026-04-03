import { execFile } from "child_process";
import { NextResponse } from "next/server";
import { promisify } from "util";
import { loadReview } from "@/lib/review-store";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const { threadId, body } = (await request.json()) as { threadId: string; body: string };
	if (!threadId || !body) {
		return NextResponse.json({ error: "Missing threadId or body" }, { status: 400 });
	}

	try {
		const mutation = `mutation {
			addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: "${threadId}", body: ${JSON.stringify(body)} }) {
				comment { id url }
			}
		}`;

		const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${mutation}`], {
			cwd: review.workingDirectory,
			timeout: 15000,
		});

		const data = JSON.parse(stdout.trim());
		const comment = data?.data?.addPullRequestReviewThreadReply?.comment;

		return NextResponse.json({ ok: true, commentId: comment?.id, url: comment?.url });
	} catch (error) {
		console.error("Failed to reply to GitHub thread:", error);
		return NextResponse.json({ error: "Failed to post reply" }, { status: 500 });
	}
}
