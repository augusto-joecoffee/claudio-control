/**
 * Layer 4: Behavior Flow Derivation
 *
 * Transforms the PR Impact Graph into reviewer-friendly flows.
 * Produces the Reviewer Flow Graph (Graph 3).
 *
 * Strategy: For each affected entrypoint, trace outbound call edges through
 * the pre-computed impact graph. Filter to keep only steps the reviewer cares
 * about. Collapse wrapper chains. Order by call depth.
 */

import type { EntrypointKind, ConfidenceLevel, SideEffect } from "../types";
import type {
	ImpactGraph, SemanticCodeGraph, SymbolId, SymbolNode,
	ReviewerFlow, FlowStep, GraphEdge, DiffAnchor,
} from "./graph-types";
import { parseSymbolId } from "./graph-types";

const MAX_TRACE_DEPTH = 12;
const MAX_RAW_STEPS = 60;
const MAX_DISPLAY_STEPS = 20;

/**
 * Derive reviewer flows from the impact graph.
 * Each affected entrypoint gets one flow.
 * Returns orphaned symbol IDs (changed but not reachable from any entrypoint).
 */
export function deriveFlows(
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): { flows: ReviewerFlow[]; orphanedSymbolIds: SymbolId[] } {
	const flows: ReviewerFlow[] = [];
	const tracedSymbols = new Set<SymbolId>();

	for (const epId of impact.affectedEntrypoints) {
		const epNode = fullGraph.nodes.get(epId) ?? impact.neighborhood.get(epId);
		if (!epNode || !epNode.entrypointKind) continue;

		const flow = buildSingleFlow(epId, epNode, impact, fullGraph);
		if (!flow || flow.steps.length === 0) continue;

		flows.push(flow);
		for (const step of flow.steps) {
			tracedSymbols.add(step.node.id);
		}
	}

	// Orphaned: changed symbols not in any flow
	const orphanedSymbolIds: SymbolId[] = [];
	for (const [id] of impact.changed) {
		if (!tracedSymbols.has(id)) {
			orphanedSymbolIds.push(id);
		}
	}

	return { flows, orphanedSymbolIds };
}

/**
 * Build a single flow from an entrypoint through the impact graph.
 */
function buildSingleFlow(
	entrypointId: SymbolId,
	entrypointNode: SymbolNode,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): ReviewerFlow | null {
	// Build a local edge index for the impact graph
	const outbound = new Map<SymbolId, GraphEdge[]>();
	for (const edge of impact.edges) {
		if (edge.kind !== "calls" && edge.kind !== "inferred-call") continue;
		const list = outbound.get(edge.from) ?? [];
		list.push(edge);
		outbound.set(edge.from, list);
	}

	// Also include edges from the full graph for the neighborhood nodes
	for (const [id] of impact.neighborhood) {
		const fullEdges = fullGraph.outbound.get(id) ?? [];
		for (const edge of fullEdges) {
			if (edge.kind !== "calls" && edge.kind !== "inferred-call") continue;
			if (!impact.neighborhood.has(edge.to)) continue;
			const list = outbound.get(edge.from) ?? [];
			if (!list.some((e) => e.to === edge.to)) {
				list.push(edge);
				outbound.set(edge.from, list);
			}
		}
	}

	// DFS trace from entrypoint
	const rawSteps: RawFlowStep[] = [];
	const visited = new Set<SymbolId>();

	traceFromEntrypoint(entrypointId, rawSteps, visited, 0, outbound, impact, fullGraph);

	if (rawSteps.length === 0) return null;

	// Filter to relevant steps
	const filtered = filterRelevantSteps(rawSteps, impact, outbound);
	if (filtered.length === 0) return null;

	// Build FlowStep objects
	const steps: FlowStep[] = filtered.map((raw, i) => ({
		node: raw.node,
		order: i,
		sideEffects: raw.node.sideEffects,
		callsTo: raw.calleeIds,
		isChanged: impact.changed.has(raw.node.id),
		changeKind: impact.changed.get(raw.node.id)?.changeKind ?? null,
		rationale: buildRationale(raw, impact),
		confidence: raw.confidence,
	}));

	// Aggregate side effects
	const sideEffectKeys = new Set<string>();
	const aggregateSideEffects: SideEffect[] = [];
	const touchedFiles = new Set<string>();

	for (const step of steps) {
		touchedFiles.add(step.node.filePath);
		for (const se of step.sideEffects) {
			const key = `${se.kind}:${se.description}`;
			if (!sideEffectKeys.has(key)) {
				sideEffectKeys.add(key);
				aggregateSideEffects.push(se);
			}
		}
	}

	const confidence = steps.reduce<ConfidenceLevel>((acc, s) => {
		const rank = { high: 2, medium: 1, low: 0 };
		return rank[s.confidence] < rank[acc] ? s.confidence : acc;
	}, "high");

	return {
		entrypoint: entrypointNode,
		entrypointKind: entrypointNode.entrypointKind!,
		steps,
		sideEffects: aggregateSideEffects,
		touchedFiles: Array.from(touchedFiles),
		confidence,
		name: nameBehavior(entrypointNode),
	};
}

// ── DFS Trace ──

interface RawFlowStep {
	node: SymbolNode;
	depth: number;
	calleeIds: SymbolId[];
	confidence: ConfidenceLevel;
}

function traceFromEntrypoint(
	nodeId: SymbolId,
	steps: RawFlowStep[],
	visited: Set<SymbolId>,
	depth: number,
	outbound: Map<SymbolId, GraphEdge[]>,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): void {
	if (depth > MAX_TRACE_DEPTH || steps.length >= MAX_RAW_STEPS) return;
	if (visited.has(nodeId)) return;
	visited.add(nodeId);

	const node = impact.neighborhood.get(nodeId) ?? fullGraph.nodes.get(nodeId);
	if (!node) return;

	const edges = outbound.get(nodeId) ?? [];
	const calleeIds = edges.map((e) => e.to);

	// Edge confidence affects step confidence
	const worstEdgeConf = edges.length > 0
		? edges.reduce<ConfidenceLevel>((acc, e) => {
			const rank = { high: 2, medium: 1, low: 0 };
			return rank[e.confidence] < rank[acc] ? e.confidence : acc;
		}, "high")
		: node.confidence;

	const stepConf: ConfidenceLevel = depth === 0
		? node.confidence
		: minConf(node.confidence, worstEdgeConf);

	steps.push({ node, depth, calleeIds, confidence: stepConf });

	// Recurse into callees
	for (const edge of edges) {
		traceFromEntrypoint(edge.to, steps, visited, depth + 1, outbound, impact, fullGraph);
	}
}

// ── Step Filtering ──

/**
 * Filter raw traced steps to keep only what the reviewer should see.
 *
 * Keep:
 * - Entrypoint (depth 0)
 * - Changed nodes
 * - Nodes with side effects
 * - Bridge nodes connecting kept nodes
 * Drop everything else.
 */
function filterRelevantSteps(
	rawSteps: RawFlowStep[],
	impact: ImpactGraph,
	outbound: Map<SymbolId, GraphEdge[]>,
): RawFlowStep[] {
	if (rawSteps.length <= MAX_DISPLAY_STEPS) return rawSteps;

	const keepIndices = new Set<number>();

	// Always keep entrypoint
	keepIndices.add(0);

	// Keep changed and side-effect nodes
	for (let i = 0; i < rawSteps.length; i++) {
		const step = rawSteps[i];
		if (impact.changed.has(step.node.id)) keepIndices.add(i);
		if (step.node.sideEffects.length > 0) keepIndices.add(i);
	}

	// Keep bridge nodes: direct callers/callees of kept nodes
	const idToIndex = new Map<SymbolId, number>();
	for (let i = 0; i < rawSteps.length; i++) {
		idToIndex.set(rawSteps[i].node.id, i);
	}

	const bridgePass = new Set(keepIndices);
	for (const idx of keepIndices) {
		const step = rawSteps[idx];
		// Callees
		for (const calleeId of step.calleeIds) {
			const cIdx = idToIndex.get(calleeId);
			if (cIdx !== undefined) bridgePass.add(cIdx);
		}
		// Callers (look backwards)
		for (let j = 0; j < rawSteps.length; j++) {
			if (rawSteps[j].calleeIds.includes(step.node.id)) {
				bridgePass.add(j);
				break;
			}
		}
	}

	return Array.from(bridgePass)
		.sort((a, b) => a - b)
		.slice(0, MAX_DISPLAY_STEPS)
		.map((i) => rawSteps[i]);
}

// ── Naming ──

function nameBehavior(node: SymbolNode): string {
	const fileName = node.filePath.split("/").pop() ?? "";
	const jobName = fileName.replace(/\.(job|worker|cron)\.(ts|js)$/, "");

	switch (node.entrypointKind) {
		case "api-route": {
			const method = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(node.name) ? node.name.toUpperCase() : "";
			const routeMatch = node.filePath.match(/(?:app|pages)(\/api\/[^.]+)\/route\.\w+$/);
			const routePath = routeMatch ? routeMatch[1] : "";
			if (method && routePath) return `${method} ${routePath}`;
			if (method) return `${method} (${fileName})`;
			return `${node.name} (${fileName})`;
		}
		case "test-function":
			return `test: ${jobName}`;
		case "react-component":
			return `<${node.name} />`;
		case "event-handler":
			return `on: ${node.name}`;
		case "queue-consumer": {
			if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(node.name)) {
				return `job: ${jobName}.${node.name}`;
			}
			return `job: ${node.name}`;
		}
		case "cli-command":
			return `cmd: ${node.name}`;
		case "cron-job": {
			if (/^(perform|prePerform|postPerform|execute|run|handle)$/.test(node.name)) {
				return `cron: ${jobName}.${node.name}`;
			}
			return `cron: ${node.name}`;
		}
		default:
			return node.qualifiedName ?? node.name;
	}
}

function buildRationale(step: RawFlowStep, impact: ImpactGraph): string {
	if (step.depth === 0) return "Entry point";
	if (impact.changed.has(step.node.id)) return "Modified by this diff";
	if (step.node.sideEffects.length > 0) return "Has side effects";
	return "Called on the path to modified code";
}

function minConf(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
	const rank = { high: 2, medium: 1, low: 0 };
	const m = Math.min(rank[a], rank[b]);
	return m === 2 ? "high" : m === 1 ? "medium" : "low";
}
