import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadReview } from "@/lib/review-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const { searchParams } = new URL(request.url);
	const filePath = searchParams.get("path");
	if (!filePath) {
		return NextResponse.json({ error: "Missing path" }, { status: 400 });
	}

	try {
		const fullPath = join(review.workingDirectory, filePath);
		const content = await readFile(fullPath, "utf-8");
		const lines = content.split("\n");
		return NextResponse.json({ lines });
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}
