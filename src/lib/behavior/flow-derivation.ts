/**
 * Layer 4: Behavior Flow Derivation (Path-Shaped, Change-Focused)
 *
 * Produces deterministic reviewer flows with this model:
 *   - One flow per impacted entrypoint + related changed component
 *   - Steps are function-level review units
 *   - Changed steps are shown fully; unchanged steps remain as path context
 *
 * The output is still reviewer-oriented, but the underlying shape is a
 * concrete call path rather than a file-centric grouping.
 */

import type { EntrypointKind, ConfidenceLevel, SideEffect } from "../types";
import type {
	ImpactGraph, SemanticCodeGraph, SymbolId, SymbolNode,
	ReviewerFlow, FlowStep,
} from "./graph-types";

const MAX_UPSTREAM_HOPS = 6;
const MAX_DOWNSTREAM_HOPS = 6;
const MAX_ENTRYPOINTS_PER_GROUP = 5;
const MAX_DOWNSTREAM_TARGETS_PER_MEMBER = 6;
const MAX_DISPLAY_STEPS = 24;

// ── Public API ──

export function deriveFlows(
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): { flows: ReviewerFlow[]; orphanedSymbolIds: SymbolId[] } {
	const groups = groupChangedSymbols(impact, fullGraph);
	const flows: ReviewerFlow[] = [];
	const tracedSymbols = new Set<SymbolId>();

	for (const group of groups) {
		const { plans: entrypointPlans, rootedMembers } = findEntrypointPlans(group.members, fullGraph);
		const coveredMembers = new Set<SymbolId>();

		if (entrypointPlans.length === 0) {
			const flow = buildFlowForPlan({ entrypointId: null, memberPaths: new Map(), minDepth: 0 }, group, impact, fullGraph);
			if (flow) {
				flows.push(flow);
				for (const step of flow.steps) {
					if (step.isChanged) tracedSymbols.add(step.node.id);
				}
			}
			continue;
		}

		for (const plan of entrypointPlans) {
			for (const memberId of plan.memberPaths.keys()) coveredMembers.add(memberId);
			const flow = buildFlowForPlan(plan, group, impact, fullGraph);
			if (!flow) continue;
			flows.push(flow);
			for (const step of flow.steps) {
				if (step.isChanged) tracedSymbols.add(step.node.id);
			}
		}

		for (const memberId of group.members) {
			if (coveredMembers.has(memberId) || rootedMembers.has(memberId) || !shouldCreateSelfRootFlow(memberId, impact, fullGraph)) continue;
			const flow = buildFlowForPlan(
				{ entrypointId: null, memberPaths: new Map([[memberId, [memberId]]]), minDepth: 0 },
				{ primary: memberId, members: [memberId] },
				impact,
				fullGraph,
			);
			if (!flow) continue;
			flows.push(flow);
			for (const step of flow.steps) {
				if (step.isChanged) tracedSymbols.add(step.node.id);
			}
		}
	}

	flows.sort((a, b) => {
		const categoryDiff = compareFlowReviewCategory(a.reviewCategory, b.reviewCategory);
		if (categoryDiff !== 0) return categoryDiff;
		const changedDiff = b.steps.filter((step) => step.isChanged).length - a.steps.filter((step) => step.isChanged).length;
		if (changedDiff !== 0) return changedDiff;
		return a.name.localeCompare(b.name);
	});

	const orphanedSymbolIds = Array.from(impact.changed.keys()).filter((id) => !tracedSymbols.has(id));
	return { flows, orphanedSymbolIds };
}

// ── Change Grouping ──

interface ChangeGroup {
	primary: SymbolId;
	members: SymbolId[];
}

function groupChangedSymbols(impact: ImpactGraph, fullGraph: SemanticCodeGraph): ChangeGroup[] {
	const changedIds = Array.from(impact.changed.keys());
	if (changedIds.length === 0) return [];

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
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	}

	const byFile = new Map<string, SymbolId[]>();
	for (const id of changedIds) {
		const node = impact.changed.get(id)?.resolvedNode ?? fullGraph.nodes.get(id);
		if (!node) continue;
		const list = byFile.get(node.filePath) ?? [];
		list.push(id);
		byFile.set(node.filePath, list);
	}

	for (const ids of byFile.values()) {
		for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
	}

	const changedSet = new Set(changedIds);
	for (const id of changedIds) {
		for (const edge of fullGraph.outbound.get(id) ?? []) {
			if (changedSet.has(edge.to)) union(id, edge.to);
		}
		for (const edge of fullGraph.inbound.get(id) ?? []) {
			if (changedSet.has(edge.from)) union(id, edge.from);
		}
	}

	const groups = new Map<SymbolId, SymbolId[]>();
	for (const id of changedIds) {
		const root = find(id);
		const list = groups.get(root) ?? [];
		list.push(id);
		groups.set(root, list);
	}

	return Array.from(groups.values())
		.map((members) => ({
			primary: pickPrimary(members, impact, fullGraph),
			members: members.sort(),
		}))
		.sort((a, b) => b.members.length - a.members.length);
}

function pickPrimary(members: SymbolId[], impact: ImpactGraph, fullGraph: SemanticCodeGraph): SymbolId {
	for (const id of members) {
		const node = impact.changed.get(id)?.resolvedNode ?? fullGraph.nodes.get(id);
		if (node?.entrypointKind) return id;
	}
	for (const id of members) {
		const node = impact.changed.get(id)?.resolvedNode ?? fullGraph.nodes.get(id);
		if (node?.isExported) return id;
	}
	return members[0];
}

// ── Entrypoint Planning ──

interface EntrypointPlan {
	entrypointId: SymbolId | null;
	memberPaths: Map<SymbolId, SymbolId[]>;
	minDepth: number;
}

interface EntrypointPlanningResult {
	plans: EntrypointPlan[];
	rootedMembers: Set<SymbolId>;
}

function findEntrypointPlans(members: SymbolId[], fullGraph: SemanticCodeGraph): EntrypointPlanningResult {
	const planMap = new Map<SymbolId, EntrypointPlan>();

	for (const memberId of members) {
		const paths = findUpstreamEntrypointPaths(memberId, fullGraph, MAX_UPSTREAM_HOPS);
		for (const path of paths) {
			const existing = planMap.get(path.entrypointId) ?? {
				entrypointId: path.entrypointId,
				memberPaths: new Map<SymbolId, SymbolId[]>(),
				minDepth: path.path.length,
			};

			const previousPath = existing.memberPaths.get(memberId);
			if (!previousPath || path.path.length < previousPath.length) {
				existing.memberPaths.set(memberId, path.path);
			}
			existing.minDepth = Math.min(existing.minDepth, path.path.length);
			planMap.set(path.entrypointId, existing);
		}
	}

	const rankedPlans = Array.from(planMap.values()).sort(compareEntrypointPlans);
	const rootedMembers = new Set<SymbolId>();
	for (const plan of rankedPlans) {
		for (const memberId of plan.memberPaths.keys()) rootedMembers.add(memberId);
	}

	const planBudget = Math.max(MAX_ENTRYPOINTS_PER_GROUP, rootedMembers.size);
	const selected: EntrypointPlan[] = [];
	const coveredMembers = new Set<SymbolId>();
	const remaining = [...rankedPlans];

	while (selected.length < planBudget && coveredMembers.size < rootedMembers.size) {
		let bestIndex = -1;
		let bestGain = 0;

		for (let i = 0; i < remaining.length; i++) {
			const gain = countNewCoverage(remaining[i], coveredMembers);
			if (gain === 0) continue;
			if (gain > bestGain) {
				bestGain = gain;
				bestIndex = i;
			}
		}

		if (bestIndex === -1) break;

		const [plan] = remaining.splice(bestIndex, 1);
		selected.push(plan);
		for (const memberId of plan.memberPaths.keys()) coveredMembers.add(memberId);
	}

	while (selected.length < planBudget && remaining.length > 0) {
		selected.push(remaining.shift()!);
	}

	return {
		plans: selected.sort(compareEntrypointPlans),
		rootedMembers,
	};
}

function findUpstreamEntrypointPaths(
	startId: SymbolId,
	fullGraph: SemanticCodeGraph,
	maxHops: number,
): Array<{ entrypointId: SymbolId; path: SymbolId[] }> {
	const startNode = fullGraph.nodes.get(startId);
	if (!startNode) return [];
	if (startNode.entrypointKind) return [{ entrypointId: startId, path: [startId] }];

	const results = new Map<SymbolId, SymbolId[]>();
	const queue: Array<{ nodeId: SymbolId; path: SymbolId[]; depth: number }> = [{ nodeId: startId, path: [startId], depth: 0 }];
	const visitedDepth = new Map<SymbolId, number>([[startId, 0]]);

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.depth >= maxHops) continue;

		for (const edge of fullGraph.inbound.get(current.nodeId) ?? []) {
			const callerId = edge.from;
			const nextDepth = current.depth + 1;
			const prevDepth = visitedDepth.get(callerId);
			if (prevDepth !== undefined && prevDepth < nextDepth) continue;
			visitedDepth.set(callerId, nextDepth);

			const nextPath = [callerId, ...current.path];
			const callerNode = fullGraph.nodes.get(callerId);
			if (!callerNode) continue;

			if (callerNode.entrypointKind) {
				const existing = results.get(callerId);
				if (!existing || nextPath.length < existing.length) results.set(callerId, nextPath);
				continue;
			}

			queue.push({ nodeId: callerId, path: nextPath, depth: nextDepth });
		}
	}

	return Array.from(results.entries()).map(([entrypointId, path]) => ({ entrypointId, path }));
}

function compareEntrypointPlans(a: EntrypointPlan, b: EntrypointPlan): number {
	if (a.minDepth !== b.minDepth) return a.minDepth - b.minDepth;
	if (a.memberPaths.size !== b.memberPaths.size) return b.memberPaths.size - a.memberPaths.size;
	return (a.entrypointId ?? "").localeCompare(b.entrypointId ?? "");
}

function countNewCoverage(plan: EntrypointPlan, coveredMembers: Set<SymbolId>): number {
	let count = 0;
	for (const memberId of plan.memberPaths.keys()) {
		if (!coveredMembers.has(memberId)) count++;
	}
	return count;
}

// ── Flow Building ──

function buildFlowForPlan(
	plan: EntrypointPlan,
	group: ChangeGroup,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): ReviewerFlow | null {
	const includedMemberIds = plan.memberPaths.size > 0
		? Array.from(plan.memberPaths.keys()).sort()
		: group.members;
	const primaryMemberId = includedMemberIds.includes(group.primary) ? group.primary : includedMemberIds[0] ?? group.primary;
	const primaryNode = impact.changed.get(primaryMemberId)?.resolvedNode ?? fullGraph.nodes.get(primaryMemberId);
	if (!primaryNode) return null;

	const entrypointNode = plan.entrypointId
		? fullGraph.nodes.get(plan.entrypointId) ?? primaryNode
		: primaryNode;
	const entrypointKind = entrypointNode.entrypointKind ?? "exported-function";
	const reviewCategory = classifyFlowReviewCategory(plan, includedMemberIds, impact, fullGraph);

	const seeds = new Map<SymbolId, { node: SymbolNode; order: number; rationale: string; confidence: ConfidenceLevel }>();
	const supplementalSideEffects: SideEffect[] = [];
	const supplementalTouchedFiles = new Set<string>();

	const upsertSeed = (
		nodeId: SymbolId,
		order: number,
		rationale: string,
		confidence: ConfidenceLevel,
	) => {
		const node = fullGraph.nodes.get(nodeId) ?? impact.changed.get(nodeId)?.resolvedNode;
		if (!node) return;

		const existing = seeds.get(nodeId);
		const next = {
			node,
			order,
			rationale: pickRationale(existing?.rationale, rationale),
			confidence: minConfidence(existing?.confidence ?? confidence, confidence),
		};

		if (!existing || order < existing.order || next.rationale !== existing.rationale || next.confidence !== existing.confidence) {
			seeds.set(nodeId, next);
		}
	};

	if (plan.memberPaths.size > 0) {
		for (const [memberId, path] of plan.memberPaths) {
			for (let i = 0; i < path.length; i++) {
				const nodeId = path[i];
				const node = fullGraph.nodes.get(nodeId) ?? impact.changed.get(nodeId)?.resolvedNode;
				if (!node) continue;
				if (i === 0 && node.entrypointKind) {
					upsertSeed(nodeId, i, "Entry point", "high");
				} else if (impact.changed.has(nodeId)) {
					upsertSeed(nodeId, i, "Modified by this diff", impact.changed.get(nodeId)?.confidence ?? "medium");
				} else {
					upsertSeed(nodeId, i, "Calls changed code", "high");
				}
			}
			if (!path.includes(memberId)) {
				upsertSeed(memberId, path.length, "Modified by this diff", impact.changed.get(memberId)?.confidence ?? "medium");
			}
		}
	} else {
		for (const memberId of includedMemberIds) {
			upsertSeed(memberId, seeds.size, "Modified by this diff", impact.changed.get(memberId)?.confidence ?? "medium");
		}
	}

	for (const memberId of includedMemberIds) {
		const downstreamPaths = findDownstreamPaths(memberId, fullGraph, impact, MAX_DOWNSTREAM_HOPS);
		for (const path of downstreamPaths) {
			for (let i = 1; i < path.length; i++) {
				const nodeId = path[i];
				const node = fullGraph.nodes.get(nodeId);
				if (!node) continue;
				const shouldShowDirectContext = i === 1 &&
					path.length === 2 &&
					isChangedCallsiteTarget(memberId, nodeId, impact, fullGraph);
				if (!impact.changed.has(nodeId) && node.sideEffects.length > 0 && !shouldShowDirectContext) {
					for (const effect of node.sideEffects) supplementalSideEffects.push(effect);
					supplementalTouchedFiles.add(node.filePath);
					continue;
				}
				if (!impact.changed.has(nodeId) && node.sideEffects.length === 0 && !shouldShowDirectContext) {
					continue;
				}
				const order = 100 + i + (seeds.get(memberId)?.order ?? 0);
				if (impact.changed.has(nodeId)) {
					upsertSeed(nodeId, order, "Modified by this diff", impact.changed.get(nodeId)?.confidence ?? "medium");
				} else if (shouldShowDirectContext) {
					upsertSeed(nodeId, order, "Touched by changed call site", "high");
				} else {
					upsertSeed(nodeId, order, "On execution path", "medium");
				}
			}
		}
	}

	for (const memberId of includedMemberIds) {
		if (!seeds.has(memberId)) {
			upsertSeed(memberId, seeds.size, "Modified by this diff", impact.changed.get(memberId)?.confidence ?? "medium");
		}
	}

	const orderedSeeds = Array.from(seeds.entries())
		.sort((a, b) => {
			const [aId, aSeed] = a;
			const [bId, bSeed] = b;
			if (aSeed.order !== bSeed.order) return aSeed.order - bSeed.order;
			if (impact.changed.has(aId) !== impact.changed.has(bId)) return impact.changed.has(aId) ? -1 : 1;
			if (aSeed.node.filePath !== bSeed.node.filePath) return aSeed.node.filePath.localeCompare(bSeed.node.filePath);
			return aSeed.node.line - bSeed.node.line;
		})
		.slice(0, MAX_DISPLAY_STEPS);

	const includedIds = new Set(orderedSeeds.map(([id]) => id));
	const steps: FlowStep[] = orderedSeeds.map(([nodeId, seed], index) => {
		const anchor = impact.changed.get(nodeId);
		return {
			node: seed.node,
			order: index,
			sideEffects: seed.node.sideEffects,
			callsTo: (fullGraph.outbound.get(nodeId) ?? [])
				.map((edge) => edge.to)
				.filter((targetId) => includedIds.has(targetId)),
			isChanged: !!anchor,
			changeKind: anchor?.changeKind ?? null,
			changedRanges: anchor?.changedRanges ?? [],
			rationale: seed.rationale,
			confidence: anchor?.confidence ?? seed.confidence,
		};
	});

	if (steps.length === 0) return null;

	const sideEffectKeys = new Set<string>();
	const sideEffects: SideEffect[] = [];
	const touchedFiles = new Set<string>(supplementalTouchedFiles);

	for (const step of steps) {
		touchedFiles.add(step.node.filePath);
		for (const effect of step.sideEffects) {
			const key = `${effect.kind}:${effect.description}`;
			if (sideEffectKeys.has(key)) continue;
			sideEffectKeys.add(key);
			sideEffects.push(effect);
		}
	}
	for (const effect of supplementalSideEffects) {
		const key = `${effect.kind}:${effect.description}`;
		if (sideEffectKeys.has(key)) continue;
		sideEffectKeys.add(key);
		sideEffects.push(effect);
	}

	const confidence = steps.reduce<ConfidenceLevel>((acc, step) => minConfidence(acc, step.confidence), "high");

	return {
		entrypoint: entrypointNode,
		entrypointKind,
		reviewCategory,
		steps,
		sideEffects,
		touchedFiles: Array.from(touchedFiles),
		confidence,
		name: nameFlow(plan.entrypointId ? entrypointNode : null, primaryNode, includedMemberIds.length),
	};
}

function findDownstreamPaths(
	startId: SymbolId,
	fullGraph: SemanticCodeGraph,
	impact: ImpactGraph,
	maxDepth: number,
): SymbolId[][] {
	const results = new Map<SymbolId, SymbolId[]>();
	const queue: Array<{ nodeId: SymbolId; path: SymbolId[]; depth: number }> = [{ nodeId: startId, path: [startId], depth: 0 }];
	const visitedDepth = new Map<SymbolId, number>([[startId, 0]]);

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.depth >= maxDepth) continue;

		for (const edge of fullGraph.outbound.get(current.nodeId) ?? []) {
			const targetId = edge.to;
			const nextDepth = current.depth + 1;
			const prevDepth = visitedDepth.get(targetId);
			if (prevDepth !== undefined && prevDepth < nextDepth) continue;
			visitedDepth.set(targetId, nextDepth);

			const nextPath = [...current.path, targetId];
			const targetNode = fullGraph.nodes.get(targetId);
			if (!targetNode) continue;

			if (
				(impact.changed.has(targetId) && targetId !== startId) ||
				targetNode.sideEffects.length > 0 ||
				(nextDepth === 1 && isChangedCallsiteTarget(startId, targetId, impact, fullGraph))
			) {
				const existing = results.get(targetId);
				if (!existing || nextPath.length < existing.length) results.set(targetId, nextPath);
			}

			queue.push({ nodeId: targetId, path: nextPath, depth: nextDepth });
		}
	}

	return Array.from(results.values())
		.sort((a, b) => a.length - b.length)
		.slice(0, MAX_DOWNSTREAM_TARGETS_PER_MEMBER);
}

function classifyFlowReviewCategory(
	plan: EntrypointPlan,
	includedMemberIds: SymbolId[],
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): ReviewerFlow["reviewCategory"] {
	if (!plan.entrypointId) {
		return includedMemberIds.some((memberId) => impact.changed.get(memberId)?.changeKind === "added")
			? "new"
			: "modified";
	}

	const entrypointNode = fullGraph.nodes.get(plan.entrypointId);
	if (!entrypointNode) return "impacted";

	const entrypointAnchor = impact.changed.get(plan.entrypointId);
	if (entrypointAnchor?.changeKind === "added") return "new";
	if (entrypointAnchor) return "modified";

	for (const memberId of includedMemberIds) {
		const anchor = impact.changed.get(memberId);
		if (!anchor) continue;
		const changedNode = anchor.resolvedNode ?? fullGraph.nodes.get(memberId);
		if (!changedNode) continue;
		if (hasFeatureAffinity(entrypointNode, changedNode)) return "modified";
	}

	return "impacted";
}

function compareFlowReviewCategory(
	a: ReviewerFlow["reviewCategory"],
	b: ReviewerFlow["reviewCategory"],
): number {
	const rank: Record<ReviewerFlow["reviewCategory"], number> = {
		new: 0,
		modified: 1,
		impacted: 2,
	};
	return rank[a] - rank[b];
}

const GENERIC_FLOW_TOKENS = new Set([
	"src", "app", "apps", "page", "pages", "api", "route", "routes",
	"job", "jobs", "worker", "workers", "cron", "crons",
	"lib", "libs", "util", "utils", "helper", "helpers", "shared", "common", "core",
	"service", "services", "module", "modules",
	"component", "components", "hook", "hooks",
	"test", "tests", "spec", "specs", "index",
	"merchant", "consumer", "client", "server", "web", "ws", "event", "events", "webhook", "webhooks",
	"handler", "handlers", "controller", "controllers",
	"ts", "tsx", "js", "jsx", "mjs", "cjs",
]);

function hasFeatureAffinity(entrypointNode: SymbolNode, changedNode: SymbolNode): boolean {
	if (entrypointNode.filePath === changedNode.filePath) return true;

	const entryTokens = extractFlowTokens(entrypointNode.filePath, entrypointNode.name);
	const changedTokens = extractFlowTokens(changedNode.filePath, changedNode.name);

	for (const token of changedTokens) {
		if (entryTokens.has(token)) return true;
	}

	return false;
}

function extractFlowTokens(filePath: string, symbolName: string): Set<string> {
	const raw = `${filePath} ${symbolName}`;
	const tokens = raw
		.split(/[^A-Za-z0-9]+/)
		.flatMap(splitFlowToken)
		.map((token) => token.toLowerCase())
		.filter((token) => token.length >= 3 && !GENERIC_FLOW_TOKENS.has(token));

	return new Set(tokens);
}

function splitFlowToken(token: string): string[] {
	if (!token) return [];
	return token
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/\s+/)
		.filter(Boolean);
}

// ── Naming ──

function nameFlow(entrypointNode: SymbolNode | null, primaryNode: SymbolNode, changedCount: number): string {
	if (entrypointNode && entrypointNode.id === primaryNode.id && entrypointNode.entrypointKind) {
		return nameEntrypoint(entrypointNode);
	}

	if (entrypointNode?.entrypointKind) {
		const entrypointName = nameEntrypoint(entrypointNode);
		if (changedCount > 1) return `${entrypointName} → ${primaryNode.name} (+${changedCount - 1})`;
		return `${entrypointName} → ${primaryNode.name}`;
	}

	const fileName = primaryNode.filePath.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
	if (changedCount > 1) return `${fileName}: ${primaryNode.name} (+${changedCount - 1})`;
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
		case "event-handler":
			return `event: ${node.qualifiedName ?? node.name}`;
		case "react-component":
			return `<${node.name} />`;
		case "queue-consumer":
			return /^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(node.name)
				? `job: ${jobName}.${node.name}`
				: `job: ${node.name}`;
		case "cron-job":
			return /^(perform|prePerform|postPerform|execute|run|handle)$/.test(node.name)
				? `cron: ${jobName}.${node.name}`
				: `cron: ${node.name}`;
		default:
			return node.qualifiedName ?? node.name;
	}
}

// ── Helpers ──

function shouldCreateSelfRootFlow(
	memberId: SymbolId,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): boolean {
	const node = impact.changed.get(memberId)?.resolvedNode ?? fullGraph.nodes.get(memberId);
	if (!node) return false;
	if (node.entrypointKind) return true;
	if (!node.isExported) return false;
	return node.kind === "function" || node.kind === "method" || node.kind === "class";
}

function isChangedCallsiteTarget(
	startId: SymbolId,
	targetId: SymbolId,
	impact: ImpactGraph,
	fullGraph: SemanticCodeGraph,
): boolean {
	const anchor = impact.changed.get(startId);
	const startNode = fullGraph.nodes.get(startId) ?? anchor?.resolvedNode;
	const targetNode = fullGraph.nodes.get(targetId);
	if (!anchor || !startNode || !targetNode) return false;

	const changedText = getChangedText(startNode, anchor.changedRanges);
	if (!changedText) return false;

	return changedTextMentionsTarget(changedText, targetNode.name);
}

function getChangedText(
	node: SymbolNode,
	ranges: Array<{ start: number; end: number }>,
): string {
	const sourceFile = typeof node.node.getSourceFile === "function" ? node.node.getSourceFile() : null;
	const allLines = sourceFile
		? sourceFile.getFullText().split("\n")
		: node.node.getText().split("\n");
	const snippets: string[] = [];

	for (const range of ranges) {
		const start = Math.max(range.start, node.line);
		const end = Math.min(range.end, node.endLine);
		for (let line = start; line <= end; line++) {
			const index = sourceFile ? line - 1 : line - node.line;
			const lineText = allLines[index];
			if (lineText !== undefined) snippets.push(lineText);
		}
	}

	return snippets.join("\n");
}

function changedTextMentionsTarget(changedText: string, targetName: string): boolean {
	if (!changedText.trim() || !targetName.trim()) return false;
	const escapedName = escapeRegExp(targetName);
	return new RegExp(`\\b${escapedName}\\b`).test(changedText);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickRationale(current: string | undefined, next: string): string {
	if (!current) return next;
	const rank: Record<string, number> = {
		"Modified by this diff": 4,
		"Entry point": 3,
		"Touched by changed call site": 2,
		"Downstream side effect": 2,
		"Calls changed code": 1,
		"On execution path": 0,
	};
	return (rank[next] ?? 0) > (rank[current] ?? 0) ? next : current;
}

function minConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
	const rank: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 };
	return rank[a] <= rank[b] ? a : b;
}
