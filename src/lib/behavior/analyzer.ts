/**
 * Behavior Analysis Orchestrator
 *
 * Wires the 5 analysis layers together and maps internal graph types
 * to the API-compatible BehaviorAnalysis output.
 *
 * Pipeline:
 *   Layer 2+3: getProjectAndGraph() → SemanticCodeGraph (cached)
 *   Layer 3:   buildEdges() → populates graph edges
 *   Layer 1:   anchorDiffToSymbols() → DiffAnchor[]
 *   Layer 3:   extractImpactGraph() → ImpactGraph
 *   Layer 4:   deriveFlows() → ReviewerFlow[]
 *   Mapping:   flowToBehavior() → BehaviorAnalysis
 */

import type {
	BehaviorAnalysis, ChangedBehavior, ChangedSymbol, ExecutionStep,
	CodeSnippet, ConfidenceLevel,
} from "../types";
import type { ReviewerFlow, SymbolNode } from "./graph-types";
import { parseSymbolId } from "./graph-types";
import { getProjectAndGraph, invalidateGraphCache } from "./symbol-index";
import { buildEdges, extractImpactGraph } from "./call-graph";
import { anchorDiffToSymbols } from "./diff-anchors";
import { deriveFlows } from "./flow-derivation";
import { ANALYZABLE_EXTENSIONS } from "./patterns";
import { buildFlowFingerprint, buildFlowKey, buildStepFingerprint, buildStepKey } from "./identity";
import { CURRENT_BEHAVIOR_ANALYSIS_VERSION } from "./version";

/**
 * Main analysis entry point. Called by index.ts.
 * Preserves the existing function signature for API compatibility.
 */
export async function analyzeWithTypeScript(
	sessionId: string,
	rawDiff: string,
	cwd: string,
	diffFingerprint: string,
): Promise<BehaviorAnalysis> {
	const start = performance.now();
	const warnings: string[] = [];

	try {
		// Determine changed file paths for cache refresh
		const { parseDiffRanges } = await import("./diff-symbols");
		const diffFiles = parseDiffRanges(rawDiff);
		const changedPaths = diffFiles
			.filter((f) => !f.isDeleted)
			.map((f) => f.filePath)
			.filter((p) => {
				const ext = p.split(".").pop()?.toLowerCase() ?? "";
				return ANALYZABLE_EXTENSIONS.has(ext);
			});

		if (changedPaths.length === 0) {
			return emptyResult(sessionId, diffFingerprint, start, [
				"No analyzable TS/JS files in the diff.",
			]);
		}

		// Layer 2: Get semantic graph (cached, refreshes changed files)
		const { project, graph } = getProjectAndGraph(cwd, changedPaths);

		const nodeCount = graph.nodes.size;
		warnings.push(`Graph: ${nodeCount} symbols indexed from project.`);

		// Layer 1: Anchor diff to AST symbols (BEFORE edges, so we know the scope)
		const { anchors, warnings: anchorWarnings } = anchorDiffToSymbols(rawDiff, project, graph, cwd);
		warnings.push(...anchorWarnings);
		warnings.push(`Anchors: ${anchors.length} changed symbols found in diff.`);

		// Determine edge-building scope: changed files + files containing entrypoints
		// + files that import from changed files (1 level).
		// This avoids running the type checker on thousands of unrelated files.
		const edgeScope = new Set<string>(changedPaths);

		// Add files with entrypoints (they might call into changed code)
		for (const [id, node] of graph.nodes) {
			if (node.entrypointKind) edgeScope.add(node.filePath);
		}

		// Add files that import from changed files (check import declarations)
		for (const sf of project.getSourceFiles()) {
			const absPath = sf.getFilePath();
			if (absPath.includes("/node_modules/")) continue;
			const relPath = makeRelative(absPath, cwd);
			if (relPath.startsWith("/")) continue;
			if (edgeScope.has(relPath)) continue;

			// Check if this file imports from any changed file
			try {
				for (const imp of sf.getImportDeclarations()) {
					const moduleSpecifier = imp.getModuleSpecifierValue();
					if (!moduleSpecifier) continue;
					// Check if the import resolves to a changed file
					for (const changed of changedPaths) {
						const changedBase = changed.replace(/\.\w+$/, "");
						if (moduleSpecifier.includes(changedBase.split("/").pop() ?? "___")) {
							edgeScope.add(relPath);
							break;
						}
					}
					if (edgeScope.has(relPath)) break;
				}
			} catch { /* skip */ }
		}

		warnings.push(`Edge scope: ${edgeScope.size} files (of ${project.getSourceFiles().length} total).`);

		// Layer 3: Build call edges ONLY for the scoped files
		const { warnings: edgeWarnings, edgeCount } = buildEdges(project, graph, cwd, edgeScope);
		warnings.push(...edgeWarnings);
		warnings.push(`Edges: ${edgeCount} call edges resolved.`);

		if (anchors.length === 0) {
			return emptyResult(sessionId, diffFingerprint, start, [
				...warnings,
				"No changed symbols could be anchored to the AST.",
			]);
		}

		// Layer 3 (cont): Extract impact graph
		const impact = extractImpactGraph(graph, anchors, 4);
		warnings.push(`Impact: ${impact.neighborhood.size} nodes in neighborhood, ${impact.nearestEntrypoints.size} nearest entrypoints, ${impact.affectedSideEffects.length} side-effect nodes.`);

		// Layer 4: Derive reviewer flows
		const { flows, orphanedSymbolIds } = deriveFlows(impact, graph);
		warnings.push(`Flows: ${flows.length} flows derived, ${orphanedSymbolIds.length} orphaned symbols.`);

		// Map to API types
		const behaviors = flows.map(flowToBehavior);
		const orphanedSymbols = orphanedSymbolIds
			.filter((id) => !shouldSuppressOrphanedSymbol(id, graph, behaviors))
			.map((id) => {
				const node = graph.nodes.get(id);
				return nodeToChangedSymbol(node ?? null, id, true);
			})
			.filter((s): s is ChangedSymbol => s !== null);

		return {
			sessionId,
			analysisVersion: CURRENT_BEHAVIOR_ANALYSIS_VERSION,
			diffFingerprint,
			behaviors,
			orphanedSymbols,
			analysisTimeMs: Math.round(performance.now() - start),
			createdAt: new Date().toISOString(),
			warnings,
		};
	} catch (e) {
		warnings.push(`Analysis error: ${e instanceof Error ? e.message : String(e)}`);
		return emptyResult(sessionId, diffFingerprint, start, warnings);
	}
}

/** Invalidate all caches. */
export function invalidateProjectCache(): void {
	invalidateGraphCache();
}

// ── Output Mapping ──

function flowToBehavior(flow: ReviewerFlow): ChangedBehavior {
	const steps: ExecutionStep[] = flow.steps.map((step, i) => {
		const stepKey = buildStepKey(step.node.id);
		const fingerprint = buildStepFingerprint(
			step.node.id,
			step.node.node.getText(),
			step.changedRanges,
			step.isChanged,
		);

		return {
			id: stepKey,
			key: stepKey,
			fingerprint,
		order: i,
		symbol: nodeToChangedSymbol(step.node, step.node.id, step.isChanged)!,
		snippet: {
			filePath: step.node.filePath,
			startLine: step.node.line,
			endLine: step.node.endLine,
			language: detectLang(step.node.filePath),
		} as CodeSnippet,
		sideEffects: step.sideEffects,
		callsTo: step.callsTo.map((id) => parseSymbolId(id).qualifiedName),
		rationale: step.rationale,
		isChanged: step.isChanged,
		changedRanges: step.changedRanges.length > 0 ? step.changedRanges : undefined,
		confidence: step.confidence,
		};
	});

	const primaryStepKey = steps.find((step) => step.isChanged)?.key ?? steps[0]?.key ?? flow.entrypoint.id;
	const entrypointKey = buildStepKey(flow.entrypoint.id);
	const flowKey = buildFlowKey(entrypointKey, primaryStepKey, steps.map((step) => step.key));
	const fingerprint = buildFlowFingerprint(
		entrypointKey,
		steps.map((step) => ({ key: step.key, fingerprint: step.fingerprint, isChanged: step.isChanged })),
	);
	const entrypointIsChanged = flow.steps.some((step) => step.node.id === flow.entrypoint.id && step.isChanged);

	return {
		id: flowKey,
		key: flowKey,
		fingerprint,
		name: flow.name,
		reviewCategory: flow.reviewCategory,
		entrypointKind: flow.entrypointKind,
		entrypoint: nodeToChangedSymbol(flow.entrypoint, flow.entrypoint.id, entrypointIsChanged)!,
		steps,
		sideEffects: flow.sideEffects,
		touchedFiles: flow.touchedFiles,
		changedStepCount: steps.filter((s) => s.isChanged).length,
		totalStepCount: steps.length,
		confidence: flow.confidence,
	};
}

function shouldSuppressOrphanedSymbol(
	symbolId: string,
	graph: { nodes: Map<string, SymbolNode> },
	behaviors: ChangedBehavior[],
): boolean {
	const node = graph.nodes.get(symbolId);
	if (!node || node.kind !== "export") return false;

	return behaviors.some((behavior) =>
		behavior.steps.some((step) =>
			step.isChanged &&
			step.symbol.location.filePath === node.filePath &&
			step.key !== symbolId,
		),
	);
}

function nodeToChangedSymbol(
	node: SymbolNode | null,
	symbolId: string,
	isChanged: boolean,
): ChangedSymbol | null {
	if (!node) {
		const { filePath, qualifiedName } = parseSymbolId(symbolId);
		return {
			name: qualifiedName,
			kind: "function",
			location: { filePath, line: 0, isChanged },
			qualifiedName,
			confidence: "low",
		};
	}

	return {
		name: node.name,
		kind: node.kind,
		location: {
			filePath: node.filePath,
			line: node.line,
			endLine: node.endLine,
			isChanged,
		},
		qualifiedName: node.qualifiedName,
		confidence: node.confidence,
	};
}

function detectLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
		mjs: "javascript", cjs: "javascript",
	};
	return map[ext] ?? "text";
}

function makeRelative(absPath: string, cwd: string): string {
	const cwdNormalized = cwd.endsWith("/") ? cwd : cwd + "/";
	if (absPath.startsWith(cwdNormalized)) return absPath.slice(cwdNormalized.length);
	return absPath;
}

function emptyResult(
	sessionId: string,
	diffFingerprint: string,
	startTime: number,
	warnings: string[],
): BehaviorAnalysis {
	return {
		sessionId,
		analysisVersion: CURRENT_BEHAVIOR_ANALYSIS_VERSION,
		diffFingerprint,
		behaviors: [],
		orphanedSymbols: [],
		analysisTimeMs: Math.round(performance.now() - startTime),
		createdAt: new Date().toISOString(),
		warnings,
	};
}
