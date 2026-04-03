/**
 * Layer 4: Behavior Flow Derivation (Change-Centric)
 *
 * Produces reviewer flows centered on WHAT CHANGED, not what's affected.
 *
 * Strategy:
 *   1. Group changed symbols by file proximity and call relationship
 *   2. For each group, build a flow:
 *      - Context: nearest entrypoint (1 step, for orientation)
 *      - Core: the changed code in execution order
 *      - Consequences: downstream side effects
 *   3. Name the flow after the primary change, not every possible caller
 */

import type { EntrypointKind, ConfidenceLevel, SideEffect } from "../types";
import type {
	ImpactGraph, SemanticCodeGraph, SymbolId, SymbolNode,
	ReviewerFlow, FlowStep, GraphEdge, DiffAnchor,
} from "./graph-types";
import { parseSymbolId } from "./graph-types";

const MAX_DOWNSTREAM_DEPTH = 6;
const MAX_DISPLAY_STEPS = 20;

// ── Public API ──

/**
 * Derive reviewer flows centered on what the PR actually changes.
 * Groups related changes, then builds a flow per group showing:
 * context entrypoint → changed code → downstream consequences.
 */
export function deriveFlows(
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): { flows: ReviewerFlow[]; orphanedSymbolIds: SymbolId[] } {
	// Step 1: Group changed symbols into coherent behaviors
	const groups = groupChangedSymbols(impact, fullGraph);

	// Step 2: Build a flow per group
	const flows: ReviewerFlow[] = [];
	const tracedSymbols = new Set<SymbolId>();

	for (const group of groups) {
		const flow = buildChangeFlow(group, impact, fullGraph);
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

// ── Change Grouping ──

interface ChangeGroup {
	/** Primary changed symbol (the "lead" of this group). */
	primary: SymbolId;
	/** All changed symbols in this group. */
	members: SymbolId[];
	/** Nearest entrypoint for context (if found). */
	entrypointId: SymbolId | null;
	/** The file that most members belong to. */
	primaryFile: string;
}

/**
 * Group changed symbols into coherent behaviors.
 *
 * Grouping rules:
 * - Changed symbols in the same file → same group
 * - Changed symbols that call each other (connected via edges) → merge groups
 * - Changed symbols that share the same nearest entrypoint → merge groups
 */
function groupChangedSymbols(impact: ImpactGraph, fullGraph: SemanticCodeGraph): ChangeGroup[] {
	const changedIds = Array.from(impact.changed.keys());
	if (changedIds.length === 0) return [];

	// Union-Find for grouping
	const parent = new Map<SymbolId, SymbolId>();
	for (const id of changedIds) parent.set(id, id);

	function find(x: SymbolId): SymbolId {
		while (parent.get(x) !== x) {
			const p = parent.get(parent.get(x)!)!;
			parent.set(x, p);
			x = p;
		}
		return x;
	}
	function union(a: SymbolId, b: SymbolId) {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	}

	// Rule 1: Same file → merge
	const byFile = new Map<string, SymbolId[]>();
	for (const id of changedIds) {
		const node = impact.changed.get(id)?.resolvedNode;
		if (!node) continue;
		const list = byFile.get(node.filePath) ?? [];
		list.push(id);
		byFile.set(node.filePath, list);
	}
	for (const [, ids] of byFile) {
		for (let i = 1; i < ids.length; i++) {
			union(ids[0], ids[i]);
		}
	}

	// Rule 2: Call each other → merge
	const changedSet = new Set(changedIds);
	for (const edge of impact.edges) {
		if (changedSet.has(edge.from) && changedSet.has(edge.to)) {
			union(edge.from, edge.to);
		}
	}
	// Also check full graph edges between changed symbols
	for (const id of changedIds) {
		const outEdges = fullGraph.outbound.get(id) ?? [];
		for (const edge of outEdges) {
			if (changedSet.has(edge.to)) union(id, edge.to);
		}
	}

	// Rule 3: Share nearest entrypoint → merge
	const byEntrypoint = new Map<SymbolId, SymbolId[]>();
	for (const id of changedIds) {
		const ep = impact.nearestEntrypoints.get(id);
		if (!ep) continue;
		const list = byEntrypoint.get(ep) ?? [];
		list.push(id);
		byEntrypoint.set(ep, list);
	}
	for (const [, ids] of byEntrypoint) {
		for (let i = 1; i < ids.length; i++) {
			union(ids[0], ids[i]);
		}
	}

	// Collect groups
	const groupMap = new Map<SymbolId, SymbolId[]>();
	for (const id of changedIds) {
		const root = find(id);
		const list = groupMap.get(root) ?? [];
		list.push(id);
		groupMap.set(root, list);
	}

	// Build ChangeGroup objects
	const groups: ChangeGroup[] = [];
	for (const [, members] of groupMap) {
		// Pick primary: prefer entrypoints, then most-changed, then first
		const primary = pickPrimary(members, impact, fullGraph);

		// Find nearest entrypoint for any member
		let entrypointId: SymbolId | null = null;
		for (const id of members) {
			const ep = impact.nearestEntrypoints.get(id);
			if (ep) { entrypointId = ep; break; }
		}

		// Primary file: most common file in the group
		const fileCounts = new Map<string, number>();
		for (const id of members) {
			const node = impact.changed.get(id)?.resolvedNode;
			if (node) fileCounts.set(node.filePath, (fileCounts.get(node.filePath) ?? 0) + 1);
		}
		let primaryFile = "";
		let maxCount = 0;
		for (const [f, c] of fileCounts) {
			if (c > maxCount) { maxCount = c; primaryFile = f; }
		}

		groups.push({ primary, members, entrypointId, primaryFile });
	}

	// Sort: largest groups first (most important changes)
	groups.sort((a, b) => b.members.length - a.members.length);

	return groups;
}

function pickPrimary(members: SymbolId[], impact: ImpactGraph, fullGraph: SemanticCodeGraph): SymbolId {
	// Prefer a member that IS an entrypoint
	for (const id of members) {
		const node = impact.changed.get(id)?.resolvedNode ?? fullGraph.nodes.get(id);
		if (node?.entrypointKind) return id;
	}
	// Prefer a member that is exported
	for (const id of members) {
		const node = impact.changed.get(id)?.resolvedNode ?? fullGraph.nodes.get(id);
		if (node?.isExported) return id;
	}
	return members[0];
}

// ── Flow Building ──

/**
 * Build a single flow for a change group.
 *
 * Structure:
 *   [Context: nearest entrypoint] → [Changed code in order] → [Downstream side effects]
 */
function buildChangeFlow(
	group: ChangeGroup,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): ReviewerFlow | null {
	const steps: FlowStep[] = [];

	// Step 0 (optional): Nearest entrypoint as context
	let entrypointNode: SymbolNode | null = null;
	let entrypointKind: EntrypointKind = "exported-function";

	if (group.entrypointId) {
		const epNode = fullGraph.nodes.get(group.entrypointId);
		if (epNode) {
			entrypointNode = epNode;
			entrypointKind = epNode.entrypointKind ?? "exported-function";

			// Only add as a step if it's not already a changed member
			if (!group.members.includes(group.entrypointId)) {
				steps.push({
					node: epNode,
					order: 0,
					sideEffects: epNode.sideEffects,
					callsTo: (fullGraph.outbound.get(group.entrypointId) ?? []).map((e) => e.to),
					isChanged: false,
					changeKind: null,
					rationale: "Entry point (context)",
					confidence: "high",
				});
			}
		}
	}

	// Core: Changed symbols in this group, ordered by file then line number
	const changedNodes: Array<{ id: SymbolId; node: SymbolNode; anchor: DiffAnchor }> = [];
	for (const id of group.members) {
		const anchor = impact.changed.get(id);
		const node = anchor?.resolvedNode ?? fullGraph.nodes.get(id);
		if (node && anchor) changedNodes.push({ id, node, anchor });
	}

	// Sort by file path then line number (approximation of execution order)
	changedNodes.sort((a, b) => {
		if (a.node.filePath !== b.node.filePath) return a.node.filePath.localeCompare(b.node.filePath);
		return a.node.line - b.node.line;
	});

	for (const { id, node, anchor } of changedNodes) {
		steps.push({
			node,
			order: steps.length,
			sideEffects: node.sideEffects,
			callsTo: (fullGraph.outbound.get(id) ?? []).map((e) => e.to),
			isChanged: true,
			changeKind: anchor.changeKind,
			rationale: "Modified by this diff",
			confidence: anchor.confidence,
		});
	}

	// Downstream: Side effects reachable from changed code (not already in steps)
	const stepIds = new Set(steps.map((s) => s.node.id));
	const downstreamSteps = traceDownstreamSideEffects(group.members, stepIds, impact, fullGraph);
	for (const ds of downstreamSteps) {
		if (steps.length >= MAX_DISPLAY_STEPS) break;
		steps.push({
			...ds,
			order: steps.length,
		});
	}

	if (steps.length === 0) return null;

	// If no entrypoint found, use the primary changed symbol
	if (!entrypointNode) {
		const primaryNode = impact.changed.get(group.primary)?.resolvedNode ?? fullGraph.nodes.get(group.primary);
		if (!primaryNode) return null;
		entrypointNode = primaryNode;
		entrypointKind = primaryNode.entrypointKind ?? "exported-function";
	}

	// Aggregate
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
		entrypointKind,
		steps,
		sideEffects: aggregateSideEffects,
		touchedFiles: Array.from(touchedFiles),
		confidence,
		name: nameFlow(group, impact, fullGraph),
	};
}

// ── Downstream Side Effects ──

function traceDownstreamSideEffects(
	startIds: SymbolId[],
	alreadyIncluded: Set<SymbolId>,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): FlowStep[] {
	const results: FlowStep[] = [];
	const visited = new Set<SymbolId>(alreadyIncluded);
	let frontier = new Set(startIds.filter((id) => !visited.has(id)));

	// Also start from already-included changed nodes
	for (const id of startIds) frontier.add(id);

	for (let depth = 0; depth < MAX_DOWNSTREAM_DEPTH && frontier.size > 0; depth++) {
		const nextFrontier = new Set<SymbolId>();
		for (const nodeId of frontier) {
			const outEdges = fullGraph.outbound.get(nodeId) ?? [];
			for (const edge of outEdges) {
				if (visited.has(edge.to)) continue;
				visited.add(edge.to);

				const node = fullGraph.nodes.get(edge.to);
				if (!node) continue;

				// Only include if it has side effects
				if (node.sideEffects.length > 0) {
					results.push({
						node,
						order: 0, // will be set by caller
						sideEffects: node.sideEffects,
						callsTo: (fullGraph.outbound.get(edge.to) ?? []).map((e) => e.to),
						isChanged: impact.changed.has(edge.to),
						changeKind: impact.changed.get(edge.to)?.changeKind ?? null,
						rationale: "Downstream side effect",
						confidence: edge.confidence,
					});
				}

				nextFrontier.add(edge.to);
			}
		}
		frontier = nextFrontier;
	}

	return results;
}

// ── Flow Naming ──

/**
 * Name the flow after what changed, not after every possible caller.
 * If the primary change IS an entrypoint, use the entrypoint naming.
 * Otherwise, use the primary symbol's name + file context.
 */
function nameFlow(group: ChangeGroup, impact: ImpactGraph, fullGraph: SemanticCodeGraph): string {
	const primaryNode = impact.changed.get(group.primary)?.resolvedNode ?? fullGraph.nodes.get(group.primary);
	if (!primaryNode) return parseSymbolId(group.primary).qualifiedName;

	// If primary is an entrypoint, use entrypoint-style naming
	if (primaryNode.entrypointKind) {
		return nameEntrypoint(primaryNode);
	}

	// If there's a known entrypoint, show "entrypoint → primary"
	if (group.entrypointId) {
		const epNode = fullGraph.nodes.get(group.entrypointId);
		if (epNode) {
			const epName = nameEntrypoint(epNode);
			return `${epName} → ${primaryNode.name}`;
		}
	}

	// Fallback: file name context + function name
	const fileName = primaryNode.filePath.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
	if (group.members.length > 1) {
		return `${fileName}: ${primaryNode.name} (+${group.members.length - 1})`;
	}
	return `${fileName}: ${primaryNode.name}`;
}

function nameEntrypoint(node: SymbolNode): string {
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
		case "queue-consumer": {
			if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(node.name)) {
				return `job: ${jobName}.${node.name}`;
			}
			return `job: ${node.name}`;
		}
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
