import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadReview } from "@/lib/review-store";
import { getDiffFingerprint, getFullDiff } from "@/lib/review-diff";
import { loadBehaviorAnalysis, saveBehaviorAnalysis } from "@/lib/behavior-store";
import { analyzeBehaviors } from "@/lib/behavior";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ sessionId: string; behaviorId: string }> },
) {
	const { sessionId, behaviorId } = await params;
	const review = await loadReview(sessionId);

	if (!review) {
		return NextResponse.json({ error: "Review not found" }, { status: 404 });
	}

	const cwd = review.workingDirectory;
	const fingerprint = await getDiffFingerprint(cwd, review.mergeBase);

	// Load or compute analysis
	let analysis = await loadBehaviorAnalysis(sessionId);
	if (!analysis || analysis.diffFingerprint !== fingerprint) {
		const rawDiff = await getFullDiff(cwd, review.mergeBase);
		analysis = await analyzeBehaviors(sessionId, rawDiff, cwd, fingerprint);
		await saveBehaviorAnalysis(sessionId, analysis);
	}

	const behavior = analysis.behaviors.find((b) => b.id === behaviorId);
	if (!behavior) {
		return NextResponse.json({ error: "Behavior not found" }, { status: 404 });
	}

	// Hydrate snippet content for each step
	const fileCache = new Map<string, string[]>();

	for (const step of behavior.steps) {
		const { filePath, startLine, endLine } = step.snippet;
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = await readFile(join(cwd, filePath), "utf-8");
				lines = content.split("\n");
				fileCache.set(filePath, lines);
			} catch {
				step.snippet.content = "// File could not be read";
				continue;
			}
		}
		step.snippet.content = lines.slice(startLine - 1, endLine).join("\n");
	}

	return NextResponse.json(behavior);
}
