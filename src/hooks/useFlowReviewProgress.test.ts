import { describe, expect, it } from "vitest";
import type { ChangedBehavior, ExecutionStep } from "@/lib/types";
import { pruneReviewState, toggleFlowReviewState, toggleStepReviewState, type ReviewState } from "./useFlowReviewProgress";

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
	return {
		id: "src/lib/orders.ts::calculateTotals",
		key: "src/lib/orders.ts::calculateTotals",
		fingerprint: "step-v1",
		order: 0,
		symbol: {
			name: "calculateTotals",
			kind: "function",
			location: { filePath: "src/lib/orders.ts", line: 10, endLine: 20, isChanged: true },
			qualifiedName: "calculateTotals",
			confidence: "high",
		},
		snippet: {
			filePath: "src/lib/orders.ts",
			startLine: 10,
			endLine: 20,
			language: "typescript",
		},
		sideEffects: [],
		callsTo: [],
		rationale: "Modified by this diff",
		isChanged: true,
		changedRanges: [{ start: 12, end: 14 }],
		confidence: "high",
		...overrides,
	};
}

function makeBehavior(step: ExecutionStep, overrides: Partial<ChangedBehavior> = {}): ChangedBehavior {
	return {
		id: "flow:checkout",
		key: "flow:checkout",
		fingerprint: "flow-v1",
		name: "POST /api/checkout → calculateTotals",
		reviewCategory: "modified",
		entrypointKind: "api-route",
		entrypoint: {
			name: "POST",
			kind: "function",
			location: { filePath: "src/app/api/checkout/route.ts", line: 1, endLine: 8, isChanged: false },
			qualifiedName: "POST",
			confidence: "high",
		},
		steps: [step],
		sideEffects: [],
		touchedFiles: ["src/app/api/checkout/route.ts", "src/lib/orders.ts"],
		changedStepCount: 1,
		totalStepCount: 1,
		confidence: "high",
		...overrides,
	};
}

describe("useFlowReviewProgress helpers", () => {
	it("prunes stale reviewed entries when fingerprints no longer match", () => {
		const state: ReviewState = {
			flows: { "flow:checkout": "flow-v1", "flow:stale": "flow-old" },
			steps: { "src/lib/orders.ts::calculateTotals": "step-v1", "src/lib/legacy.ts::old": "old-step" },
		};

		const next = pruneReviewState(
			state,
			{ "flow:checkout": "flow-v1" },
			{ "src/lib/orders.ts::calculateTotals": "step-v1" },
		);

		expect(next).toEqual({
			flows: { "flow:checkout": "flow-v1" },
			steps: { "src/lib/orders.ts::calculateTotals": "step-v1" },
		});
	});

	it("marking a flow reviewed also marks its changed steps reviewed", () => {
		const step = makeStep();
		const behavior = makeBehavior(step);

		const next = toggleFlowReviewState({ flows: {}, steps: {} }, behavior, [behavior]);

		expect(next.flows[behavior.id]).toBe(behavior.fingerprint);
		expect(next.steps[step.id]).toBe(step.fingerprint);
	});

	it("unmarking a changed step clears any reviewed flows that include it", () => {
		const step = makeStep();
		const behavior = makeBehavior(step);
		const initial = toggleFlowReviewState({ flows: {}, steps: {} }, behavior, [behavior]);

		const next = toggleStepReviewState(initial, [behavior], step);

		expect(next.steps[step.id]).toBeUndefined();
		expect(next.flows[behavior.id]).toBeUndefined();
	});

	it("marking a flow auto-completes sibling flows that share now-viewed steps", () => {
		const sharedStep = makeStep({ id: "shared::fn", fingerprint: "shared-v1" });
		const flowA = makeBehavior(sharedStep, { id: "flow:A", key: "flow:A", fingerprint: "A-v1" });
		const flowB = makeBehavior(sharedStep, { id: "flow:B", key: "flow:B", fingerprint: "B-v1" });

		const next = toggleFlowReviewState({ flows: {}, steps: {} }, flowA, [flowA, flowB]);

		expect(next.flows["flow:A"]).toBe("A-v1");
		expect(next.flows["flow:B"]).toBe("B-v1"); // auto-completed
		expect(next.steps["shared::fn"]).toBe("shared-v1");
	});

	it("marking individual steps auto-completes parent flow when last step is marked", () => {
		const step1 = makeStep({ id: "step::1", fingerprint: "s1-v1" });
		const step2 = makeStep({ id: "step::2", fingerprint: "s2-v1" });
		const behavior = makeBehavior(step1, {
			id: "flow:multi",
			fingerprint: "multi-v1",
			steps: [step1, step2],
			changedStepCount: 2,
			totalStepCount: 2,
		});

		// Mark first step — flow should NOT auto-complete yet
		const after1 = toggleStepReviewState({ flows: {}, steps: {} }, [behavior], step1);
		expect(after1.flows["flow:multi"]).toBeUndefined();

		// Mark second step — flow SHOULD auto-complete
		const after2 = toggleStepReviewState(after1, [behavior], step2);
		expect(after2.flows["flow:multi"]).toBe("multi-v1");
	});

	it("unmarking a step removes auto-completed flow", () => {
		const step1 = makeStep({ id: "step::1", fingerprint: "s1-v1" });
		const step2 = makeStep({ id: "step::2", fingerprint: "s2-v1" });
		const behavior = makeBehavior(step1, {
			id: "flow:multi",
			fingerprint: "multi-v1",
			steps: [step1, step2],
			changedStepCount: 2,
			totalStepCount: 2,
		});

		// Mark both steps → flow auto-completes
		let state = toggleStepReviewState({ flows: {}, steps: {} }, [behavior], step1);
		state = toggleStepReviewState(state, [behavior], step2);
		expect(state.flows["flow:multi"]).toBe("multi-v1");

		// Unmark one step → flow should be removed
		state = toggleStepReviewState(state, [behavior], step1);
		expect(state.flows["flow:multi"]).toBeUndefined();
		expect(state.steps["step::1"]).toBeUndefined();
		expect(state.steps["step::2"]).toBe("s2-v1"); // other step stays
	});

	it("flows with zero changed steps are never auto-completed", () => {
		const contextStep = makeStep({ id: "ctx::fn", isChanged: false });
		const behavior = makeBehavior(contextStep, {
			id: "flow:ctx-only",
			fingerprint: "ctx-v1",
			changedStepCount: 0,
		});

		const next = toggleFlowReviewState({ flows: {}, steps: {} }, behavior, [behavior]);

		// The flow itself was explicitly toggled so it IS marked, but auto-complete
		// should not mark context-only flows from other triggers
		const changedStep = makeStep({ id: "other::fn", fingerprint: "other-v1" });
		const otherFlow = makeBehavior(changedStep, { id: "flow:other", fingerprint: "other-flow-v1" });
		const state = toggleFlowReviewState({ flows: {}, steps: {} }, otherFlow, [otherFlow, behavior]);
		expect(state.flows["flow:ctx-only"]).toBeUndefined(); // not auto-completed
	});
});
