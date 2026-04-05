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

		const next = toggleFlowReviewState({ flows: {}, steps: {} }, behavior);

		expect(next.flows[behavior.id]).toBe(behavior.fingerprint);
		expect(next.steps[step.id]).toBe(step.fingerprint);
	});

	it("unmarking a changed step clears any reviewed flows that include it", () => {
		const step = makeStep();
		const behavior = makeBehavior(step);
		const initial = toggleFlowReviewState({ flows: {}, steps: {} }, behavior);

		const next = toggleStepReviewState(initial, [behavior], step);

		expect(next.steps[step.id]).toBeUndefined();
		expect(next.flows[behavior.id]).toBeUndefined();
	});
});
