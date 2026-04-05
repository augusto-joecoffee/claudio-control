import { describe, expect, it } from "vitest";
import type { SideEffect } from "../types";
import type { DiffAnchor, ImpactGraph, SymbolNode } from "./graph-types";
import { addEdge, createEmptyGraph, makeSymbolId, type SemanticCodeGraph } from "./graph-types";
import { deriveFlows } from "./flow-derivation";

function makeNode(
	filePath: string,
	name: string,
	line: number,
	entrypointKind: SymbolNode["entrypointKind"] = null,
	sideEffects: SideEffect[] = [],
	text?: string,
): SymbolNode {
	const qualifiedName = name;
	return {
		id: makeSymbolId(filePath, qualifiedName),
		name,
		qualifiedName,
		kind: "function",
		filePath,
		line,
		endLine: line + ((text ?? `function ${name}() {}`).split("\n").length - 1),
		node: {
			getText: () => text ?? `function ${name}() {}`,
		} as any,
		isExported: true,
		entrypointKind,
		sideEffects,
		confidence: "high",
	};
}

function makeAnchor(node: SymbolNode, overrides: Partial<DiffAnchor> = {}): DiffAnchor {
	return {
		symbolId: node.id,
		filePath: node.filePath,
		changeKind: "body-modified",
		changedRanges: [{ start: node.line, end: node.line + 1 }],
		resolvedNode: node,
		confidence: "high",
		...overrides,
	};
}

describe("deriveFlows", () => {
	it("creates one impacted flow per entrypoint for a shared changed helper", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const sideEffect: SideEffect = {
			kind: "db-write",
			description: "orders.insert()",
			location: { filePath: "src/lib/persist.ts", line: 30, isChanged: false },
			confidence: "high",
		};

		const checkout = makeNode("src/app/api/checkout/route.ts", "POST", 1, "api-route");
		const quote = makeNode("src/app/api/quote/route.ts", "POST", 1, "api-route");
		const helper = makeNode("src/lib/orders.ts", "calculateTotals", 20);
		const persist = makeNode("src/lib/persist.ts", "saveOrder", 30, null, [sideEffect]);

		for (const node of [checkout, quote, helper, persist]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: checkout.id, to: helper.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: quote.id, to: helper.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: helper.id, to: persist.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([[helper.id, makeAnchor(helper)]]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows, orphanedSymbolIds } = deriveFlows(impact, graph);

		expect(orphanedSymbolIds).toEqual([]);
		expect(flows).toHaveLength(2);
		expect(flows.map((flow) => flow.name).sort()).toEqual([
			"POST /api/checkout → calculateTotals",
			"POST /api/quote → calculateTotals",
		]);
		for (const flow of flows) {
			expect(flow.steps.some((step) => step.node.id === helper.id && step.isChanged)).toBe(true);
			expect(flow.steps.some((step) => step.node.id === persist.id)).toBe(false);
			expect(flow.sideEffects.some((effect) => effect.description === sideEffect.description)).toBe(true);
		}
	});

	it("does not leak unrelated changed members from the same group into every flow", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const entrypointA = makeNode("src/app/api/a/route.ts", "POST", 1, "api-route");
		const entrypointB = makeNode("src/app/api/b/route.ts", "POST", 1, "api-route");
		const firstChanged = makeNode("src/lib/shared.ts", "firstChanged", 10);
		const secondChanged = makeNode("src/lib/shared.ts", "secondChanged", 40);

		for (const node of [entrypointA, entrypointB, firstChanged, secondChanged]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: entrypointA.id, to: firstChanged.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: entrypointB.id, to: secondChanged.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([
				[firstChanged.id, makeAnchor(firstChanged)],
				[secondChanged.id, makeAnchor(secondChanged)],
			]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows } = deriveFlows(impact, graph);
		expect(flows).toHaveLength(2);

		const flowA = flows.find((flow) => flow.name.startsWith("POST /api/a"));
		const flowB = flows.find((flow) => flow.name.startsWith("POST /api/b"));

		expect(flowA?.steps.some((step) => step.node.id === firstChanged.id && step.isChanged)).toBe(true);
		expect(flowA?.steps.some((step) => step.node.id === secondChanged.id && step.isChanged)).toBe(false);
		expect(flowB?.steps.some((step) => step.node.id === secondChanged.id && step.isChanged)).toBe(true);
		expect(flowB?.steps.some((step) => step.node.id === firstChanged.id && step.isChanged)).toBe(false);
	});

	it("creates a self-rooted flow for uncovered changed exports inside a grouped component", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const entrypoint = makeNode("src/app/api/login/route.ts", "POST", 1, "api-route");
		const rootedChanged = makeNode("src/lib/auth.ts", "login", 10);
		const uncoveredExport = makeNode("src/lib/auth.ts", "convertSquareCustomer", 40);
		const downstream = makeNode("src/lib/customer.ts", "convertSquareCustomerToJoeUser", 70);

		for (const node of [entrypoint, rootedChanged, uncoveredExport, downstream]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: entrypoint.id, to: rootedChanged.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: rootedChanged.id, to: downstream.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: uncoveredExport.id, to: downstream.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([
				[rootedChanged.id, makeAnchor(rootedChanged)],
				[uncoveredExport.id, makeAnchor(uncoveredExport)],
				[downstream.id, makeAnchor(downstream)],
			]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows, orphanedSymbolIds } = deriveFlows(impact, graph);

		expect(orphanedSymbolIds).toEqual([]);
		expect(flows).toHaveLength(2);
		expect(flows.some((flow) => flow.name.startsWith("POST /api/login"))).toBe(true);
		expect(flows.some((flow) => flow.name === "auth: convertSquareCustomer")).toBe(true);

		const selfRootFlow = flows.find((flow) => flow.name === "auth: convertSquareCustomer");
		expect(selfRootFlow?.steps.some((step) => step.node.id === uncoveredExport.id && step.isChanged)).toBe(true);
		expect(selfRootFlow?.steps.some((step) => step.node.id === downstream.id && step.isChanged)).toBe(true);
	});

	it("prefers a real rooted entrypoint over a self-root fallback when plan ranking is crowded", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const upload = makeNode("src/app/api/upload/route.ts", "POST", 1, "api-route");
		const onlineA = makeNode("src/app/api/online-a/route.ts", "POST", 1, "api-route");
		const onlineB = makeNode("src/app/api/online-b/route.ts", "POST", 1, "api-route");
		const onlineC = makeNode("src/app/api/online-c/route.ts", "POST", 1, "api-route");
		const posA = makeNode("src/app/api/pos-a/route.ts", "POST", 1, "api-route");
		const posB = makeNode("src/app/api/pos-b/route.ts", "POST", 1, "api-route");
		const posC = makeNode("src/app/api/pos-c/route.ts", "POST", 1, "api-route");
		const getUploadFees = makeNode("src/utils/pricing.ts", "getUploadFees", 10);
		const getOnlineLoyaltyFee = makeNode("src/utils/pricing.ts", "getOnlineLoyaltyFee", 40);
		const getPosLoyaltyFee = makeNode("src/utils/pricing.ts", "getPosLoyaltyFee", 70);

		for (const node of [
			upload,
			onlineA,
			onlineB,
			onlineC,
			posA,
			posB,
			posC,
			getUploadFees,
			getOnlineLoyaltyFee,
			getPosLoyaltyFee,
		]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: upload.id, to: getUploadFees.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: getUploadFees.id, to: getOnlineLoyaltyFee.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: getUploadFees.id, to: getPosLoyaltyFee.id, kind: "calls", confidence: "high", isAsync: false });

		for (const entrypoint of [onlineA, onlineB, onlineC]) {
			addEdge(graph, { from: entrypoint.id, to: getOnlineLoyaltyFee.id, kind: "calls", confidence: "high", isAsync: false });
		}
		for (const entrypoint of [posA, posB, posC]) {
			addEdge(graph, { from: entrypoint.id, to: getPosLoyaltyFee.id, kind: "calls", confidence: "high", isAsync: false });
		}

		const impact: ImpactGraph = {
			changed: new Map([
				[getUploadFees.id, makeAnchor(getUploadFees)],
				[getOnlineLoyaltyFee.id, makeAnchor(getOnlineLoyaltyFee)],
				[getPosLoyaltyFee.id, makeAnchor(getPosLoyaltyFee)],
			]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows, orphanedSymbolIds } = deriveFlows(impact, graph);

		expect(orphanedSymbolIds).toEqual([]);
		expect(flows.some((flow) => flow.entrypoint.id === upload.id)).toBe(true);
		expect(
			flows.some((flow) =>
				flow.entrypoint.id === upload.id &&
				flow.steps.some((step) => step.node.id === getUploadFees.id && step.isChanged),
			),
		).toBe(true);
		expect(flows.some((flow) => flow.entrypoint.id === getUploadFees.id)).toBe(false);
	});

	it("orders new flows before modified flows before impacted flows", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const newEntry = makeNode("src/app/api/new-checkout/route.ts", "POST", 1, "api-route");
		const modifiedEntry = makeNode("src/app/api/checkout/route.ts", "POST", 1, "api-route");
		const impactedEntry = makeNode("src/app/api/orders/route.ts", "POST", 1, "api-route");
		const modifiedStep = makeNode("src/lib/checkout.ts", "createOrder", 20);
		const unchangedIntermediate = makeNode("src/lib/orders.ts", "placeOrder", 40);
		const impactedHelper = makeNode("src/lib/pricing.ts", "calculateTotals", 60);

		for (const node of [newEntry, modifiedEntry, impactedEntry, modifiedStep, unchangedIntermediate, impactedHelper]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: modifiedEntry.id, to: modifiedStep.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: impactedEntry.id, to: unchangedIntermediate.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: unchangedIntermediate.id, to: impactedHelper.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([
				[newEntry.id, makeAnchor(newEntry, { changeKind: "added" })],
				[modifiedStep.id, makeAnchor(modifiedStep)],
				[impactedHelper.id, makeAnchor(impactedHelper)],
			]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows } = deriveFlows(impact, graph);

		expect(flows.map((flow) => flow.reviewCategory)).toEqual(["new", "modified", "impacted"]);
		expect(flows.map((flow) => flow.name)).toEqual([
			"POST /api/new-checkout",
			"POST /api/checkout → createOrder",
			"POST /api/orders → calculateTotals",
		]);
	});

	it("classifies shared infra helpers as impacted and feature-affine helpers as modified", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const checkTasksEntry = makeNode("src/jobs/challenges/checkUserTasks.job.ts", "prePerform", 10, "queue-consumer");
		const rejectOrderEntry = makeNode("src/jobs/order/rejectUnacceptedOrder.job.ts", "perform", 20, "queue-consumer");
		const abortJob = makeNode("src/utils/queue.ts", "abortJob", 40);
		const refundOrderCharges = makeNode("src/utils/order.ts", "refundOrderCharges", 60);
		const recalculateOrderTotals = makeNode("src/utils/order.ts", "recalculateOrderTotals", 80);

		for (const node of [checkTasksEntry, rejectOrderEntry, abortJob, refundOrderCharges, recalculateOrderTotals]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: checkTasksEntry.id, to: abortJob.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: rejectOrderEntry.id, to: refundOrderCharges.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: refundOrderCharges.id, to: recalculateOrderTotals.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([
				[abortJob.id, makeAnchor(abortJob)],
				[recalculateOrderTotals.id, makeAnchor(recalculateOrderTotals)],
			]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows } = deriveFlows(impact, graph);

		const abortFlow = flows.find((flow) => flow.entrypoint.id === checkTasksEntry.id);
		const orderFlow = flows.find((flow) => flow.entrypoint.id === rejectOrderEntry.id);

		expect(abortFlow?.reviewCategory).toBe("impacted");
		expect(orderFlow?.reviewCategory).toBe("modified");
	});

	it("keeps touched downstream callees, hides unchanged side-effect cards, and preserves their impact", () => {
		const graph: SemanticCodeGraph = createEmptyGraph();
		const createUserText = [
			"function createUser() {",
			"  const shareCode = generateUniqueShareCode();",
			"  isUSPhone(phone);",
			"  saveUser(shareCode);",
			"}",
		].join("\n");
		const sideEffect: SideEffect = {
			kind: "db-write",
			description: "users.insert()",
			location: { filePath: "src/lib/users.ts", line: 40, isChanged: false },
			confidence: "high",
		};

		const entrypoint = makeNode("src/app/api/users/route.ts", "POST", 1, "api-route");
		const createUser = makeNode("src/lib/users.ts", "createUser", 10, null, [], createUserText);
		const touchedHelper = makeNode("src/lib/users.ts", "generateUniqueShareCode", 30);
		const noisyHelper = makeNode("src/lib/phones.ts", "isUSPhone", 50);
		const sideEffectNode = makeNode("src/lib/persist.ts", "saveUser", 70, null, [sideEffect]);

		for (const node of [entrypoint, createUser, touchedHelper, noisyHelper, sideEffectNode]) {
			graph.nodes.set(node.id, node);
		}

		addEdge(graph, { from: entrypoint.id, to: createUser.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: createUser.id, to: touchedHelper.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: createUser.id, to: noisyHelper.id, kind: "calls", confidence: "high", isAsync: false });
		addEdge(graph, { from: createUser.id, to: sideEffectNode.id, kind: "calls", confidence: "high", isAsync: false });

		const impact: ImpactGraph = {
			changed: new Map([[
				createUser.id,
				{
					...makeAnchor(createUser),
					changedRanges: [{ start: 11, end: 11 }],
				},
			]]),
			neighborhood: new Map(),
			edges: [],
			nearestEntrypoints: new Map(),
			affectedSideEffects: [],
		};

		const { flows } = deriveFlows(impact, graph);
		expect(flows).toHaveLength(1);

			const stepIds = flows[0]?.steps.map((step) => step.node.id) ?? [];
			expect(stepIds).toContain(entrypoint.id);
			expect(stepIds).toContain(createUser.id);
			expect(stepIds).toContain(touchedHelper.id);
			expect(stepIds).not.toContain(sideEffectNode.id);
			expect(stepIds).not.toContain(noisyHelper.id);
			expect(flows[0]?.sideEffects.some((effect) => effect.description === sideEffect.description)).toBe(true);

			const helperStep = flows[0]?.steps.find((step) => step.node.id === touchedHelper.id);
			expect(helperStep?.rationale).toBe("Touched by changed call site");
		});
});
