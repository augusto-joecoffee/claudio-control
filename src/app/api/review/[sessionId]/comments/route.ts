import { NextResponse } from "next/server";
import { loadReview, saveReview } from "@/lib/review-store";
import type { ReviewComment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	return NextResponse.json({ comments: review.comments });
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const body = await request.json();
	const { filePath, line, content, anchorSnippet } = body as {
		filePath: string;
		line: number;
		content: string;
		anchorSnippet: string;
	};

	if (!filePath || !line || !content) {
		return NextResponse.json({ error: "Missing filePath, line, or content" }, { status: 400 });
	}

	const comment: ReviewComment = {
		id: crypto.randomUUID(),
		filePath,
		line,
		originalLine: line,
		anchorSnippet: anchorSnippet || "",
		content,
		status: "pending",
		createdAt: new Date().toISOString(),
		resolvedAt: null,
		response: null,
	};

	review.comments.push(comment);
	await saveReview(sessionId, review);

	return NextResponse.json({ comment });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const { commentId, action } = (await request.json()) as { commentId: string; action: "resolve" | "delete" };
	const idx = review.comments.findIndex((c) => c.id === commentId);
	if (idx === -1) {
		return NextResponse.json({ error: "Comment not found" }, { status: 404 });
	}

	if (action === "delete") {
		review.comments.splice(idx, 1);
	} else if (action === "resolve") {
		review.comments[idx].status = "resolved";
		review.comments[idx].resolvedAt = new Date().toISOString();
	}

	await saveReview(sessionId, review);
	return NextResponse.json({ ok: true });
}
