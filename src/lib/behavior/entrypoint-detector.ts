/**
 * Classify which changed symbols are entrypoints (API routes, event handlers,
 * test functions, job performers, etc.) using file-path patterns and code patterns.
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
 *
 * Strategy:
 * 1. File-path patterns (highest priority) — e.g. route.ts, *.job.ts, *.test.ts
 * 2. Code-body patterns — e.g. app.get(), router.post()
 * 3. Top-level exported functions that appear to be "leaves" (not imported by other changed files)
 *    — but ONLY for exported functions/consts, NOT for random methods.
 *    — and only if the function body itself contains meaningful logic (not just a re-export object).
 */
export function detectEntrypoints(
	symbols: ChangedSymbol[],
	fileContents: Map<string, string>,
	fileLines: Map<string, string[]>,
): DetectedEntrypoint[] {
	const entrypoints: DetectedEntrypoint[] = [];
	const seenQualified = new Set<string>();

	// Pre-build a set of all symbol names and their files for import checking
	const symbolNameToFiles = new Map<string, Set<string>>();
	for (const sym of symbols) {
		const files = symbolNameToFiles.get(sym.name) ?? new Set();
		files.add(sym.location.filePath);
		symbolNameToFiles.set(sym.name, files);
	}

	for (const symbol of symbols) {
		// Only consider changed symbols as entrypoints
		if (!symbol.location.isChanged) continue;

		// Skip type-only symbols
		if (symbol.kind === "type") continue;

		const filePath = symbol.location.filePath;
		const key = symbol.qualifiedName ?? symbol.name;
		if (seenQualified.has(key)) continue;

		let detected = false;

		// 1. Check file-path-based patterns (highest priority)
		for (const pattern of ENTRYPOINT_FILE_PATTERNS) {
			if (!pattern.pathMatch.test(filePath)) continue;
			if (pattern.symbolMatch && !pattern.symbolMatch.test(symbol.name)) continue;

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

		// 2. Check code-pattern-based rules (ONLY on exported functions/top-level consts)
		if (symbol.kind !== "function" && symbol.kind !== "export") continue;

		const lines = fileLines.get(filePath);
		if (!lines) continue;

		const startLine = symbol.location.line - 1; // 0-based
		const endLine = Math.min((symbol.location.endLine ?? symbol.location.line + 10) - 1, lines.length);
		const body = lines.slice(startLine, endLine).join("\n");

		for (const pattern of ENTRYPOINT_CODE_PATTERNS) {
			if (!pattern.codeMatch.test(body)) continue;

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

		// 3. Top-level exported functions that are not imported by other changed files.
		//    Only for explicitly exported functions (not methods, not types).
		const line = lines[startLine] ?? "";
		if (!/^export\s+/.test(line)) continue;
		if (symbol.kind !== "function") continue;

		// Check if any other changed file imports this symbol name
		const isImported = isSymbolImportedByOtherFiles(symbol.name, filePath, fileContents);
		if (isImported) continue;

		// Additional filter: the function must have a non-trivial body.
		// Skip re-export objects like `export const foo = { prePerform, perform }`
		// and simple one-liners.
		const bodyLineCount = endLine - startLine;
		if (bodyLineCount < 3) continue;

		seenQualified.add(key);
		entrypoints.push({
			symbol,
			kind: "exported-function",
			confidence: "low",
		});
	}

	return entrypoints;
}

function isSymbolImportedByOtherFiles(
	symbolName: string,
	sourceFilePath: string,
	fileContents: Map<string, string>,
): boolean {
	const baseName = sourceFilePath.replace(/\.\w+$/, "").split("/").pop();
	if (!baseName) return false;

	for (const [otherPath, otherContent] of fileContents) {
		if (otherPath === sourceFilePath) continue;

		// Check for import statement that references both the symbol name and the source file
		// This is a rough heuristic but avoids false positives from unrelated identifier matches
		const importRegex = new RegExp(
			`import\\s+(?:(?:\\{[^}]*\\b${escapeRegex(symbolName)}\\b[^}]*\\})|(?:${escapeRegex(symbolName)}))\\s+from\\s+['"][^'"]*${escapeRegex(baseName)}`,
		);
		if (importRegex.test(otherContent)) return true;
	}

	return false;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
