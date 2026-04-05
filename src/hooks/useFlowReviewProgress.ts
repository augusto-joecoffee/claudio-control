import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangedBehavior, ExecutionStep } from "@/lib/types";

interface ReviewState {
	flows: Record<string, string>;
	steps: Record<string, string>;
}

export type { ReviewState };

function loadState(storageKey: string): ReviewState {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return { flows: {}, steps: {} };
		const parsed = JSON.parse(raw);
		return {
			flows: parsed?.flows ?? {},
			steps: parsed?.steps ?? {},
		};
	} catch {
		return { flows: {}, steps: {} };
	}
}

function saveState(storageKey: string, state: ReviewState) {
	localStorage.setItem(storageKey, JSON.stringify(state));
}

export function pruneReviewState(
	state: ReviewState,
	currentFlowFingerprints: Record<string, string>,
	currentStepFingerprints: Record<string, string>,
): ReviewState {
	const next: ReviewState = { flows: {}, steps: {} };

	for (const [flowId, fingerprint] of Object.entries(state.flows)) {
		if (currentFlowFingerprints[flowId] === fingerprint) {
			next.flows[flowId] = fingerprint;
		}
	}

	for (const [stepId, fingerprint] of Object.entries(state.steps)) {
		if (currentStepFingerprints[stepId] === fingerprint) {
			next.steps[stepId] = fingerprint;
		}
	}

	return next;
}

/** Auto-mark any flow whose changed steps are all individually viewed. */
function autoCompleteFlows(state: ReviewState, allBehaviors: ChangedBehavior[]): void {
	for (const b of allBehaviors) {
		if (state.flows[b.id] === b.fingerprint) continue;
		const changedSteps = b.steps.filter((s) => s.isChanged);
		if (changedSteps.length === 0) continue;
		if (changedSteps.every((s) => state.steps[s.id] === s.fingerprint)) {
			state.flows[b.id] = b.fingerprint;
		}
	}
}

export function toggleFlowReviewState(state: ReviewState, behavior: ChangedBehavior, allBehaviors: ChangedBehavior[]): ReviewState {
	const next: ReviewState = {
		flows: { ...state.flows },
		steps: { ...state.steps },
	};

	if (next.flows[behavior.id] === behavior.fingerprint) {
		delete next.flows[behavior.id];
		return next;
	}

	next.flows[behavior.id] = behavior.fingerprint;
	for (const step of behavior.steps) {
		if (!step.isChanged) continue;
		next.steps[step.id] = step.fingerprint;
	}
	autoCompleteFlows(next, allBehaviors);
	return next;
}

export function toggleStepReviewState(
	state: ReviewState,
	behaviors: ChangedBehavior[],
	step: ExecutionStep,
): ReviewState {
	if (!step.isChanged) return state;

	const next: ReviewState = {
		flows: { ...state.flows },
		steps: { ...state.steps },
	};

	if (next.steps[step.id] === step.fingerprint) {
		delete next.steps[step.id];
		for (const behavior of behaviors) {
			if (behavior.steps.some((candidate) => candidate.isChanged && candidate.id === step.id)) {
				delete next.flows[behavior.id];
			}
		}
	} else {
		next.steps[step.id] = step.fingerprint;
		autoCompleteFlows(next, behaviors);
	}

	return next;
}

export function useFlowReviewProgress(sessionId: string, behaviors: ChangedBehavior[]) {
	const storageKey = `behavior-reviewed-${sessionId}`;
	const [state, setState] = useState<ReviewState>(() => loadState(storageKey));

	const currentFlowFingerprints = useMemo(
		() => Object.fromEntries(behaviors.map((behavior) => [behavior.id, behavior.fingerprint])),
		[behaviors],
	);
	const currentStepFingerprints = useMemo(
		() =>
			Object.fromEntries(
				behaviors.flatMap((behavior) => behavior.steps.map((step) => [step.id, step.fingerprint] as const)),
			),
		[behaviors],
	);

	useEffect(() => {
		setState((prev) => {
			const next = pruneReviewState(prev, currentFlowFingerprints, currentStepFingerprints);
			if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
			saveState(storageKey, next);
			return next;
		});
	}, [currentFlowFingerprints, currentStepFingerprints, storageKey]);

	const isReviewed = useCallback(
		(behaviorId: string) => currentFlowFingerprints[behaviorId] !== undefined && state.flows[behaviorId] === currentFlowFingerprints[behaviorId],
		[currentFlowFingerprints, state.flows],
	);

	const isStepReviewed = useCallback(
		(stepId: string) => currentStepFingerprints[stepId] !== undefined && state.steps[stepId] === currentStepFingerprints[stepId],
		[currentStepFingerprints, state.steps],
	);

	const setReviewState = useCallback(
		(updater: (prev: ReviewState) => ReviewState) => {
			setState((prev) => {
				const next = updater(prev);
				saveState(storageKey, next);
				return next;
			});
		},
		[storageKey],
	);

	const toggleReviewed = useCallback(
		(behavior: ChangedBehavior) => {
			setReviewState((prev) => toggleFlowReviewState(prev, behavior, behaviors));
		},
		[setReviewState, behaviors],
	);

	const toggleStepReviewed = useCallback(
		(step: ExecutionStep) => {
			setReviewState((prev) => toggleStepReviewState(prev, behaviors, step));
		},
		[behaviors, setReviewState],
	);

	const reviewedCount = useMemo(
		() => behaviors.filter((behavior) => isReviewed(behavior.id)).length,
		[behaviors, isReviewed],
	);

	return {
		isReviewed,
		toggleReviewed,
		reviewedCount,
		isStepReviewed,
		toggleStepReviewed,
	};
}
