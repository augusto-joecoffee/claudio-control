/**
 * Layer 1: Diff Anchors
 *
 * Maps PR diff hunks to AST nodes and enclosing symbols. This is the exact
 * layer — it answers "which symbols changed and how?" by walking the ts-morph
 * AST for each changed file.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Project, SourceFile } from "ts-morph";
import { resolve } from "path";
import type { DiffAnchor, SymbolNode, SemanticCodeGraph, ChangeKind } from "./graph-types";
import { makeSymbolId } from "./graph-types";
import { parseDiffRanges } from "./diff-symbols";
import type { DiffFileInfo, ChangedRange } from "./diff-symbols";
import { ANALYZABLE_EXTENSIONS } from "./patterns";

/**
 * Parse the raw diff and resolve each changed hunk to the AST symbol it falls within.
 * Uses the semantic graph to look up pre-indexed symbols.
 */
export function anchorDiffToSymbols(
	rawDiff: string,
	project: Project,
	graph: SemanticCodeGraph,
	cwd: string,
): { anchors: DiffAnchor[]; diffFiles: DiffFileInfo[]; warnings: string[] } {
	const warnings: string[] = [];
	const diffFiles = parseDiffRanges(rawDiff);
	const anchors: DiffAnchor[] = [];
	const seenIds = new Set<string>();

	const analyzableFiles = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return ANALYZABLE_EXTENSIONS.has(ext);
	});

	for (const df of analyzableFiles) {
		if (df.changedRanges.length === 0) continue;

		const absPath = resolve(cwd, df.filePath);
		const sourceFile = project.getSourceFile(absPath);
		if (!sourceFile) {
			warnings.push(`Could not load source file: ${df.filePath}`);
			continue;
		}

		// Find which symbols in the graph this file touches
		const fileAnchors = anchorFileChanges(sourceFile, df, graph);
		for (const anchor of fileAnchors) {
			if (!seenIds.has(anchor.symbolId)) {
				seenIds.add(anchor.symbolId);
				anchors.push(anchor);
			}
		}
	}

	// Report non-analyzable files
	const nonAnalyzable = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return !ANALYZABLE_EXTENSIONS.has(ext);
	});
	if (nonAnalyzable.length > 0) {
		warnings.push(`${nonAnalyzable.length} non-JS/TS file(s) not analyzed: ${nonAnalyzable.map((f) => f.filePath.split("/").pop()).join(", ")}`);
	}

	return { anchors, diffFiles, warnings };
}

/**
 * For a single changed file, find all symbols that overlap with changed ranges.
 */
function anchorFileChanges(
	sourceFile: SourceFile,
	diffFile: DiffFileInfo,
	graph: SemanticCodeGraph,
): DiffAnchor[] {
	const anchors: DiffAnchor[] = [];
	const relPath = diffFile.filePath;
	const ranges = diffFile.changedRanges;

	// Look up symbols in the graph that belong to this file
	for (const [id, node] of graph.nodes) {
		if (node.filePath !== relPath) continue;

		// Check if this symbol overlaps with any changed range
		const overlapping = ranges.filter(
			(r) => node.line <= r.end && node.endLine >= r.start,
		);

		if (overlapping.length === 0) continue;

		const changeKind = classifyChange(node, overlapping, sourceFile);

		anchors.push({
			symbolId: id,
			filePath: relPath,
			changeKind,
			changedRanges: overlapping,
			resolvedNode: node,
			confidence: "high", // exact AST overlap
		});
	}

	// Also check for ranges that don't fall inside any indexed symbol
	// These are changes in file-level code (imports, top-level statements, etc.)
	for (const range of ranges) {
		const covered = anchors.some((a) =>
			a.changedRanges.some((r) => r.start <= range.start && r.end >= range.end),
		);
		if (!covered) {
			// Try to find the nearest enclosing function using AST walk
			const enclosing = findEnclosingSymbol(sourceFile, range.start, relPath, graph);
			if (enclosing && !anchors.some((a) => a.symbolId === enclosing.id)) {
				anchors.push({
					symbolId: enclosing.id,
					filePath: relPath,
					changeKind: "body-modified",
					changedRanges: [range],
					resolvedNode: enclosing,
					confidence: "medium",
				});
			}
		}
	}

	return anchors;
}

/**
 * Classify the nature of a change by examining which lines within the
 * symbol's span were modified.
 */
function classifyChange(
	node: SymbolNode,
	overlappingRanges: ChangedRange[],
	sourceFile: SourceFile,
): ChangeKind {
	// If the entire symbol is new (all lines are additions), it's "added"
	const totalLines = node.endLine - node.line + 1;
	const changedLines = overlappingRanges.reduce((sum, r) => {
		const start = Math.max(r.start, node.line);
		const end = Math.min(r.end, node.endLine);
		return sum + (end - start + 1);
	}, 0);

	if (changedLines >= totalLines * 0.9) return "added";

	// Check if changes are in the signature area (first 1-3 lines of the declaration)
	const signatureEnd = node.line + 2; // rough heuristic: first 3 lines
	const signatureChanged = overlappingRanges.some(
		(r) => r.start <= signatureEnd && r.end >= node.line,
	);

	// Check if changes are only in the body (after the signature)
	const bodyChanged = overlappingRanges.some((r) => r.start > signatureEnd);

	if (signatureChanged && !bodyChanged) return "signature-changed";
	return "body-modified";
}

/**
 * Find the nearest enclosing function/method for a line in the source file.
 * Falls back to walking the AST directly when the graph doesn't have coverage.
 */
function findEnclosingSymbol(
	sourceFile: SourceFile,
	line: number,
	relPath: string,
	graph: SemanticCodeGraph,
): SymbolNode | null {
	// First check graph nodes
	let best: SymbolNode | null = null;
	let bestSize = Infinity;

	for (const [id, node] of graph.nodes) {
		if (node.filePath !== relPath) continue;
		if (node.line <= line && node.endLine >= line) {
			const size = node.endLine - node.line;
			if (size < bestSize) {
				bestSize = size;
				best = node;
			}
		}
	}

	return best;
}
