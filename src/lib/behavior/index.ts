/**
 * Behavior analysis orchestrator.
 * Ties together all pipeline stages: diff parsing → symbol extraction →
 * entrypoint detection → call graph → execution paths → final analysis.
 */

import type { BehaviorAnalysis, ChangedSymbol } from "../types";
import { extractChangedSymbols } from "./diff-symbols";
import { detectEntrypoints } from "./entrypoint-detector";
import { buildCallGraph } from "./call-graph";
import { generateExecutionPaths } from "./execution-path";
import type { ChangedRange } from "./diff-symbols";

/**
 * Run the full behavior analysis pipeline on a diff.
 *
 * @param sessionId - Review session ID (for the analysis record)
 * @param rawDiff - Raw unified diff text (from getFullDiff)
 * @param cwd - Working directory of the repository
 * @param diffFingerprint - Cache key from getDiffFingerprint
 */
export async function analyzeBehaviors(
	sessionId: string,
	rawDiff: string,
	cwd: string,
	diffFingerprint: string,
): Promise<BehaviorAnalysis> {
	const start = performance.now();
	const warnings: string[] = [];

	// Stage 1: Parse diff and extract changed symbols
	const { symbols, diffFiles, fileContents, fileLines } = await extractChangedSymbols(rawDiff, cwd);

	if (symbols.length === 0) {
		return {
			sessionId,
			diffFingerprint,
			behaviors: [],
			orphanedSymbols: [],
			analysisTimeMs: Math.round(performance.now() - start),
			createdAt: new Date().toISOString(),
			warnings: ["No analyzable symbols found in the diff (TS/JS files only)."],
		};
	}

	// Build changed ranges map for execution-path module
	const changedRangesMap = new Map<string, ChangedRange[]>();
	for (const df of diffFiles) {
		changedRangesMap.set(df.filePath, df.changedRanges);
	}

	// Stage 2: Detect entrypoints
	const entrypoints = detectEntrypoints(symbols, fileContents, fileLines);

	if (entrypoints.length === 0) {
		warnings.push("No entrypoints detected. All changed symbols are listed as untraced.");
	}

	// Stage 3: Build approximate call graph
	const { graph, warnings: graphWarnings } = await buildCallGraph(symbols, fileContents, fileLines, cwd);
	warnings.push(...graphWarnings);

	// Stage 4: Generate execution paths
	const behaviors = generateExecutionPaths(entrypoints, symbols, graph, fileLines, changedRangesMap);

	// Stage 5: Identify orphaned symbols (changed but not in any behavior)
	const tracedSymbols = new Set<string>();
	for (const behavior of behaviors) {
		for (const step of behavior.steps) {
			tracedSymbols.add(step.symbol.qualifiedName ?? step.symbol.name);
		}
	}

	const orphanedSymbols = symbols.filter((s) => {
		if (!s.location.isChanged) return false;
		const key = s.qualifiedName ?? s.name;
		return !tracedSymbols.has(key);
	});

	if (orphanedSymbols.length > 0) {
		warnings.push(`${orphanedSymbols.length} changed symbol(s) could not be traced to any entrypoint.`);
	}

	// Report files that are not analyzable
	const nonAnalyzable = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return !["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext);
	});
	if (nonAnalyzable.length > 0) {
		warnings.push(`${nonAnalyzable.length} non-JS/TS file(s) not analyzed: ${nonAnalyzable.map((f) => f.filePath.split("/").pop()).join(", ")}`);
	}

	const analysisTimeMs = Math.round(performance.now() - start);

	return {
		sessionId,
		diffFingerprint,
		behaviors,
		orphanedSymbols,
		analysisTimeMs,
		createdAt: new Date().toISOString(),
		warnings,
	};
}
