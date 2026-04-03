import type { ConfidenceLevel, ChangedBehavior, ExecutionStep } from "../types";

/** Return the lower of two confidence levels. */
export function minConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
	const rank: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 };
	const minRank = Math.min(rank[a], rank[b]);
	return minRank === 2 ? "high" : minRank === 1 ? "medium" : "low";
}

/** Compute overall confidence for a behavior based on its steps. */
export function scoreBehaviorConfidence(steps: ExecutionStep[]): ConfidenceLevel {
	if (steps.length === 0) return "low";
	let result: ConfidenceLevel = "high";
	for (const step of steps) {
		result = minConfidence(result, step.confidence);
		if (result === "low") return "low"; // early exit
	}
	return result;
}

/** Determine symbol confidence based on how precisely it overlaps a changed hunk. */
export function symbolConfidence(
	symbolLine: number,
	symbolEndLine: number,
	changedRanges: Array<{ start: number; end: number }>,
): { confidence: ConfidenceLevel; isChanged: boolean } {
	for (const range of changedRanges) {
		// Symbol body overlaps a changed hunk
		if (symbolLine <= range.end && symbolEndLine >= range.start) {
			return { confidence: "high", isChanged: true };
		}
	}
	// Within 5 lines of a change
	for (const range of changedRanges) {
		if (symbolLine <= range.end + 5 && symbolEndLine >= range.start - 5) {
			return { confidence: "medium", isChanged: false };
		}
	}
	return { confidence: "low", isChanged: false };
}
