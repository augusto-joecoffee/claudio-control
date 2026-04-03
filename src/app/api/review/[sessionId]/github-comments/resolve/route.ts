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

	const { threadId } = (await request.json()) as { threadId: string };
	if (!threadId) {
		return NextResponse.json({ error: "Missing threadId" }, { status: 400 });
	}

	try {
		const mutation = `mutation {
			resolveReviewThread(input: { threadId: "${threadId}" }) {
				thread { id isResolved }
			}
		}`;

		await execFileAsync("gh", ["api", "graphql", "-f", `query=${mutation}`], {
			cwd: review.workingDirectory,
			timeout: 15000,
		});

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Failed to resolve GitHub thread:", error);
		return NextResponse.json({ error: "Failed to resolve thread" }, { status: 500 });
	}
}
