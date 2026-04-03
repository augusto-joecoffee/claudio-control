/**
 * Classify which changed symbols are entrypoints (API routes, event handlers,
 * test functions, etc.) using file-path patterns and code patterns.
 */

import type { ChangedSymbol, EntrypointKind, ConfidenceLevel } from "../types";
import { ENTRYPOINT_FILE_PATTERNS, ENTRYPOINT_CODE_PATTERNS } from "./patterns";
import { minConfidence } from "./confidence";

export interface DetectedEntrypoint {
	symbol: ChangedSymbol;
	kind: EntrypointKind;
	confidence: ConfidenceLevel;
}

/**
 * Detect entrypoints among changed symbols.
 * Returns a subset of symbols classified as entrypoints with their kind.
 */
export function detectEntrypoints(
	symbols: ChangedSymbol[],
	fileContents: Map<string, string>,
	fileLines: Map<string, string[]>,
): DetectedEntrypoint[] {
	const entrypoints: DetectedEntrypoint[] = [];
	const seenQualified = new Set<string>();

	for (const symbol of symbols) {
		// Only consider changed symbols as entrypoints
		if (!symbol.location.isChanged) continue;

		const filePath = symbol.location.filePath;
		let detected = false;

		// 1. Check file-path-based patterns (highest priority)
		for (const pattern of ENTRYPOINT_FILE_PATTERNS) {
			if (!pattern.pathMatch.test(filePath)) continue;
			if (pattern.symbolMatch && !pattern.symbolMatch.test(symbol.name)) continue;

			const key = symbol.qualifiedName ?? symbol.name;
			if (seenQualified.has(key)) break;
			seenQualified.add(key);

			entrypoints.push({
				symbol,
				kind: pattern.kind,
				confidence: minConfidence(symbol.confidence, pattern.confidence),
			});
			detected = true;
			break;
		}

		if (detected) continue;

		// 2. Check code-pattern-based rules (look at the symbol's body)
		const lines = fileLines.get(filePath);
		if (!lines) continue;

		const startLine = symbol.location.line - 1; // 0-based
		const endLine = Math.min((symbol.location.endLine ?? symbol.location.line + 10) - 1, lines.length);
		const body = lines.slice(startLine, endLine).join("\n");

		for (const pattern of ENTRYPOINT_CODE_PATTERNS) {
			if (!pattern.codeMatch.test(body)) continue;

			const key = symbol.qualifiedName ?? symbol.name;
			if (seenQualified.has(key)) break;
			seenQualified.add(key);

			entrypoints.push({
				symbol,
				kind: pattern.kind,
				confidence: minConfidence(symbol.confidence, pattern.confidence),
			});
			detected = true;
			break;
		}

		if (detected) continue;

		// 3. Exported functions that aren't imported by other changed files → potential entrypoint
		const content = fileContents.get(filePath) ?? "";
		const line = lines[startLine] ?? "";
		if (/^export\s+/.test(line) && symbol.kind !== "type") {
			// Check if any other changed file imports this symbol
			const isImported = Array.from(fileContents.entries()).some(([otherPath, otherContent]) => {
				if (otherPath === filePath) return false;
				// Simple check: does the other file import this symbol name from a path containing this file?
				const baseName = filePath.replace(/\.\w+$/, "").split("/").pop();
				return otherContent.includes(symbol.name) && baseName && otherContent.includes(baseName);
			});

			if (!isImported) {
				const key = symbol.qualifiedName ?? symbol.name;
				if (!seenQualified.has(key)) {
					seenQualified.add(key);
					entrypoints.push({
						symbol,
						kind: "exported-function",
						confidence: "low",
					});
				}
			}
		}
	}

	return entrypoints;
}
