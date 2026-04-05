import type { SideEffect, FileLocation, ConfidenceLevel } from "../types";
import { SIDE_EFFECT_PATTERNS } from "./patterns";

/**
 * Detect side effects within a block of source code by pattern matching.
 * Returns all detected side effects with their locations.
 */
export function detectSideEffects(
	lines: string[],
	filePath: string,
	startLine: number,
): SideEffect[] {
	const results: SideEffect[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = startLine + i;

		for (const pattern of SIDE_EFFECT_PATTERNS) {
			const m = line.match(pattern.match);
			if (!m) continue;

			// Build description from template
			let description = pattern.descriptionTemplate;
			description = description.replace("$0", m[0].trim());
			for (let g = 1; g < m.length; g++) {
				description = description.replace(`$${g}`, m[g] ?? "");
			}

			// Deduplicate by kind + description within the same block
			const key = `${pattern.kind}:${description}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const location: FileLocation = {
				filePath,
				line: lineNumber,
				isChanged: false, // Caller should update this based on diff ranges
			};

			results.push({
				kind: pattern.kind,
				description,
				location,
				confidence: pattern.confidence,
			});
		}
	}

	return results;
}
