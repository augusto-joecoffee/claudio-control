/**
 * Internal graph types for the layered behavior analysis system.
 *
 * These types flow between the 5 analysis layers but are NOT exposed to the
 * API or frontend. The final output is mapped to the existing BehaviorAnalysis
 * types in types.ts by the orchestrator (analyzer.ts).
 *
 * Three graphs:
 *   1. SemanticCodeGraph — full project symbol + edge index (cached per repo)
 *   2. ImpactGraph — diff-centered subgraph (per PR)
 *   3. ReviewerFlow — derived behavioral flows for review (per PR)
 */

import type { Node } from "ts-morph";
import type { EntrypointKind, SideEffect, ConfidenceLevel } from "../types";

// ── Identifiers ──

/**
 * Unique identifier for a symbol node. Format: "relPath::qualifiedName"
 * Using the file path prevents collisions between identically-named
 * functions in different files (e.g. utils.ts::validate vs auth.ts::validate).
 */
export type SymbolId = string;

export function makeSymbolId(filePath: string, qualifiedName: string): SymbolId {
	return `${filePath}::${qualifiedName}`;
}

export function parseSymbolId(id: SymbolId): { filePath: string; qualifiedName: string } {
	const idx = id.indexOf("::");
	if (idx === -1) return { filePath: "", qualifiedName: id };
	return { filePath: id.slice(0, idx), qualifiedName: id.slice(idx + 2) };
}

// ── Change Classification ──

export type ChangeKind =
	| "body-modified"      // lines inside the function body changed
	| "signature-changed"  // parameters, return type, or name changed
	| "added"              // entirely new symbol
	| "deleted";           // symbol removed

// ── Edge Types ──

export type EdgeKind =
	| "calls"              // A calls B (type-checker resolved)
	| "imports"            // A imports B
	| "exports"            // module exports symbol
	| "method-of"          // method → owning class
	| "registers-route"    // framework route registration
	| "emits"              // event emission
	| "subscribes"         // event/queue subscription
	| "inferred-call";     // best-effort (dynamic dispatch, pattern-based)

export interface GraphEdge {
	from: SymbolId;
	to: SymbolId;
	kind: EdgeKind;
	confidence: ConfidenceLevel;
	/** True if edge crosses an async boundary (await, .then, queue hop). */
	isAsync: boolean;
}

// ── Graph 1: Semantic Code Graph (per-repo, cached) ──

export interface SymbolNode {
	id: SymbolId;
	name: string;
	qualifiedName: string;
	kind: "function" | "method" | "class" | "variable" | "type" | "export";
	filePath: string;
	line: number;
	endLine: number;
	/** ts-morph Node reference. Not serialized when caching to disk. */
	node: Node;
	isExported: boolean;
	/** Classified entrypoint kind, or null if not an entrypoint. */
	entrypointKind: EntrypointKind | null;
	/** Side effects detected statically in this symbol's body. */
	sideEffects: SideEffect[];
	confidence: ConfidenceLevel;
}

export interface SemanticCodeGraph {
	nodes: Map<SymbolId, SymbolNode>;
	edges: GraphEdge[];
	/** Reverse index: edges pointing TO a node. */
	inbound: Map<SymbolId, GraphEdge[]>;
	/** Forward index: edges going FROM a node. */
	outbound: Map<SymbolId, GraphEdge[]>;
	builtAt: number;
}

export function createEmptyGraph(): SemanticCodeGraph {
	return {
		nodes: new Map(),
		edges: [],
		inbound: new Map(),
		outbound: new Map(),
		builtAt: Date.now(),
	};
}

export function addEdge(graph: SemanticCodeGraph, edge: GraphEdge): void {
	graph.edges.push(edge);
	const inList = graph.inbound.get(edge.to) ?? [];
	inList.push(edge);
	graph.inbound.set(edge.to, inList);
	const outList = graph.outbound.get(edge.from) ?? [];
	outList.push(edge);
	graph.outbound.set(edge.from, outList);
}

// ── Layer 1 Output: Diff Anchors ──

export interface DiffAnchor {
	symbolId: SymbolId;
	filePath: string;
	changeKind: ChangeKind;
	changedRanges: Array<{ start: number; end: number }>;
	/** The symbol node if resolved in the semantic graph. */
	resolvedNode: SymbolNode | null;
	confidence: ConfidenceLevel;
}

// ── Graph 2: PR Impact Graph (per-diff) ──

export interface ImpactGraph {
	/** Changed symbols (diff anchors that resolved to graph nodes). */
	changed: Map<SymbolId, DiffAnchor>;
	/** All nodes reachable within N hops of a changed node. */
	neighborhood: Map<SymbolId, SymbolNode>;
	/** Edges within the neighborhood subgraph. */
	edges: GraphEdge[];
	/** For each changed symbol, the nearest entrypoint that reaches it (upstream context). */
	nearestEntrypoints: Map<SymbolId, SymbolId>;
	/** Side effects reachable from changed nodes (downstream). */
	affectedSideEffects: Array<{ symbolId: SymbolId; effects: SideEffect[] }>;
}

// ── Graph 3: Reviewer Flow Graph (per-diff) ──

export interface ReviewerFlow {
	entrypoint: SymbolNode;
	entrypointKind: EntrypointKind;
	reviewCategory: "new" | "modified" | "impacted";
	steps: FlowStep[];
	sideEffects: SideEffect[];
	touchedFiles: string[];
	confidence: ConfidenceLevel;
	name: string;
}

export interface FlowStep {
	node: SymbolNode;
	order: number;
	sideEffects: SideEffect[];
	callsTo: SymbolId[];
	isChanged: boolean;
	changeKind: ChangeKind | null;
	/** Exact diff-changed line ranges (1-based, inclusive). */
	changedRanges: Array<{ start: number; end: number }>;
	rationale: string;
	confidence: ConfidenceLevel;
}
