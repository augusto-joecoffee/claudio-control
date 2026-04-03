/**
 * Layer 3: Reference and Call Graph
 *
 * Builds call/reference edges between symbol nodes using the TypeScript type
 * checker. Enriches the SemanticCodeGraph with edges.
 *
 * Also provides extractImpactGraph() which produces the PR Impact Graph
 * (Graph 2) by BFS from changed nodes through the full graph.
 */

import { SyntaxKind, Node } from "ts-morph";
import type { Project } from "ts-morph";
import type { ConfidenceLevel } from "../types";
import type {
	SemanticCodeGraph, SymbolNode, SymbolId, GraphEdge, EdgeKind,
	ImpactGraph, DiffAnchor,
} from "./graph-types";
import { makeSymbolId, addEdge } from "./graph-types";

/**
 * Populate call edges in the semantic graph using the type checker.
 * Should be called after symbol-index has populated all nodes.
 */
export function buildEdges(
	project: Project,
	graph: SemanticCodeGraph,
	cwd: string,
): { warnings: string[] } {
	const warnings: string[] = [];

	// Clear existing edges (in case of re-index)
	graph.edges = [];
	graph.inbound = new Map();
	graph.outbound = new Map();

	for (const [fromId, fromNode] of graph.nodes) {
		// Skip types and exports — they don't make calls
		if (fromNode.kind === "type" || fromNode.kind === "export") continue;

		try {
			const callEdges = resolveNodeCalls(fromNode, graph, cwd);
			for (const edge of callEdges) {
				addEdge(graph, edge);
			}
		} catch (e) {
			warnings.push(`Edge resolution failed for ${fromNode.qualifiedName}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return { warnings };
}

/**
 * Resolve outgoing calls from a single symbol node.
 * Uses multiple resolution strategies for accuracy.
 */
function resolveNodeCalls(
	fromNode: SymbolNode,
	graph: SemanticCodeGraph,
	cwd: string,
): GraphEdge[] {
	const edges: GraphEdge[] = [];
	const seen = new Set<SymbolId>();

	try {
		const callExpressions = fromNode.node.getDescendantsOfKind(SyntaxKind.CallExpression);

		for (const call of callExpressions) {
			try {
				const result = resolveCallTarget(call, graph, cwd);
				if (!result) continue;

				const { targetId, confidence, isAsync } = result;
				if (seen.has(targetId)) continue;
				seen.add(targetId);

				edges.push({
					from: fromNode.id,
					to: targetId,
					kind: "calls",
					confidence,
					isAsync,
				});
			} catch { /* individual call can fail */ }
		}
	} catch { /* descendant traversal can fail */ }

	return edges;
}

/**
 * Resolve a single call expression to a target SymbolId in the graph.
 * Tries multiple strategies in order of reliability.
 */
function resolveCallTarget(
	call: Node,
	graph: SemanticCodeGraph,
	cwd: string,
): { targetId: SymbolId; confidence: ConfidenceLevel; isAsync: boolean } | null {
	const expr = (call as any).getExpression?.() as Node | undefined;
	if (!expr) return null;

	// Detect async: is this call awaited?
	const isAsync = call.getParent()?.getKind() === SyntaxKind.AwaitExpression
		|| (call as any).getExpression?.()?.getText?.()?.includes(".then") === true;

	// Strategy 1: getSymbol() on the expression
	let tsSym = expr.getSymbol?.() ?? null;

	// Strategy 2: Follow aliased symbols (re-exports, import aliases)
	if (tsSym) {
		try {
			const aliased = tsSym.getAliasedSymbol?.();
			if (aliased) tsSym = aliased;
		} catch { /* not an alias */ }
	}

	// Strategy 3: For property access (this.foo(), obj.foo())
	if (!tsSym && Node.isPropertyAccessExpression(expr)) {
		try {
			const nameNode = expr.getNameNode();
			tsSym = nameNode.getSymbol?.() ?? null;
			if (tsSym) {
				try {
					const aliased = tsSym.getAliasedSymbol?.();
					if (aliased) tsSym = aliased;
				} catch { /* not an alias */ }
			}
		} catch { /* ignore */ }
	}

	// Strategy 4: Call signature from expression type
	if (!tsSym) {
		try {
			const exprType = expr.getType();
			const callSignatures = exprType.getCallSignatures();
			if (callSignatures.length > 0) {
				const sigDecl = callSignatures[0].getDeclaration();
				if (sigDecl) tsSym = sigDecl.getSymbol?.() ?? null;
			}
		} catch { /* ignore */ }
	}

	if (!tsSym) return null;

	const declarations = tsSym.getDeclarations();
	if (declarations.length === 0) return null;

	const decl = declarations[0];
	const declFile = decl.getSourceFile().getFilePath();

	// Skip node_modules
	if (declFile.includes("/node_modules/")) return null;

	const relPath = makeRelative(declFile, cwd);
	if (relPath.startsWith("/")) return null;

	const declName = tsSym.getName();
	if (!declName || declName === "__function" || declName === "__object") return null;

	const parentClass = getParentClassName(decl);
	const qualifiedName = parentClass ? `${parentClass}.${declName}` : declName;
	const targetId = makeSymbolId(relPath, qualifiedName);

	// Check if target exists in graph
	if (graph.nodes.has(targetId)) {
		return { targetId, confidence: "high", isAsync };
	}

	// Try without file path (for symbols that might be indexed with a different path)
	for (const [id, node] of graph.nodes) {
		if (node.qualifiedName === qualifiedName && node.filePath === relPath) {
			return { targetId: id, confidence: "high", isAsync };
		}
	}

	// Try just by name (less confident)
	for (const [id, node] of graph.nodes) {
		if (node.name === declName && node.filePath === relPath) {
			return { targetId: id, confidence: "medium", isAsync };
		}
	}

	return null;
}

// ── Impact Graph Extraction ──

/**
 * Extract the PR Impact Graph (Graph 2) by walking outward from changed nodes.
 *
 * Walks UPSTREAM (callers, via inbound edges) to find affected entrypoints.
 * Walks DOWNSTREAM (callees, via outbound edges) to find affected side effects.
 * Collects the neighborhood subgraph within maxHops.
 */
export function extractImpactGraph(
	fullGraph: SemanticCodeGraph,
	anchors: DiffAnchor[],
	maxHops: number = 4,
): ImpactGraph {
	const changed = new Map<SymbolId, DiffAnchor>();
	const neighborhood = new Map<SymbolId, SymbolNode>();
	const impactEdges: GraphEdge[] = [];
	const affectedEntrypoints: SymbolId[] = [];
	const affectedSideEffects: Array<{ symbolId: SymbolId; effects: typeof fullGraph extends never ? never : any[] }> = [];

	// Seed with changed symbols
	for (const anchor of anchors) {
		if (anchor.resolvedNode) {
			changed.set(anchor.symbolId, anchor);
			neighborhood.set(anchor.symbolId, anchor.resolvedNode);
		}
	}

	if (changed.size === 0) {
		return { changed, neighborhood, edges: [], affectedEntrypoints: [], affectedSideEffects: [] };
	}

	// BFS upstream: find entrypoints that can reach changed code
	const upstreamVisited = new Set<SymbolId>();
	let frontier = new Set(changed.keys());

	for (let hop = 0; hop < maxHops && frontier.size > 0; hop++) {
		const nextFrontier = new Set<SymbolId>();
		for (const nodeId of frontier) {
			if (upstreamVisited.has(nodeId)) continue;
			upstreamVisited.add(nodeId);

			const node = fullGraph.nodes.get(nodeId);
			if (node) {
				neighborhood.set(nodeId, node);
				if (node.entrypointKind && !affectedEntrypoints.includes(nodeId)) {
					affectedEntrypoints.push(nodeId);
				}
			}

			// Follow inbound edges (callers)
			const inEdges = fullGraph.inbound.get(nodeId) ?? [];
			for (const edge of inEdges) {
				if (!upstreamVisited.has(edge.from)) {
					nextFrontier.add(edge.from);
					impactEdges.push(edge);
				}
			}
		}
		frontier = nextFrontier;
	}

	// BFS downstream: find side effects reachable from changed code
	const downstreamVisited = new Set<SymbolId>();
	frontier = new Set(changed.keys());
	const sideEffectSet = new Set<SymbolId>();

	for (let hop = 0; hop < maxHops && frontier.size > 0; hop++) {
		const nextFrontier = new Set<SymbolId>();
		for (const nodeId of frontier) {
			if (downstreamVisited.has(nodeId)) continue;
			downstreamVisited.add(nodeId);

			const node = fullGraph.nodes.get(nodeId);
			if (node) {
				neighborhood.set(nodeId, node);
				if (node.sideEffects.length > 0 && !sideEffectSet.has(nodeId)) {
					sideEffectSet.add(nodeId);
					affectedSideEffects.push({ symbolId: nodeId, effects: node.sideEffects });
				}
			}

			// Follow outbound edges (callees)
			const outEdges = fullGraph.outbound.get(nodeId) ?? [];
			for (const edge of outEdges) {
				if (!downstreamVisited.has(edge.to)) {
					nextFrontier.add(edge.to);
					impactEdges.push(edge);
				}
			}
		}
		frontier = nextFrontier;
	}

	// Also include entrypoints of changed nodes themselves
	for (const [id, anchor] of changed) {
		const node = anchor.resolvedNode;
		if (node?.entrypointKind && !affectedEntrypoints.includes(id)) {
			affectedEntrypoints.push(id);
		}
	}

	// Deduplicate edges
	const edgeSet = new Set<string>();
	const uniqueEdges = impactEdges.filter((e) => {
		const key = `${e.from}->${e.to}:${e.kind}`;
		if (edgeSet.has(key)) return false;
		edgeSet.add(key);
		return true;
	});

	return {
		changed,
		neighborhood,
		edges: uniqueEdges,
		affectedEntrypoints,
		affectedSideEffects,
	};
}

// ── Helpers ──

function getParentClassName(node: Node): string | null {
	const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
	return cls?.getName() ?? null;
}

function makeRelative(absPath: string, cwd: string): string {
	const cwdNormalized = cwd.endsWith("/") ? cwd : cwd + "/";
	if (absPath.startsWith(cwdNormalized)) return absPath.slice(cwdNormalized.length);
	return absPath;
}
