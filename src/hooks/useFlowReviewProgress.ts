import { useCallback, useMemo, useState } from "react";

/**
 * Track which flows have been reviewed in a session.
 * Mirrors the useViewedFiles pattern: localStorage-backed with session scoping.
 */
export function useFlowReviewProgress(sessionId: string) {
	const storageKey = `behavior-reviewed-${sessionId}`;

	const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => {
		try {
			const stored = localStorage.getItem(storageKey);
			if (stored) return new Set(JSON.parse(stored));
		} catch { /* ignore */ }
		return new Set();
	});

	const isReviewed = useCallback(
		(behaviorId: string) => reviewedIds.has(behaviorId),
		[reviewedIds],
	);

	const toggleReviewed = useCallback(
		(behaviorId: string) => {
			setReviewedIds((prev) => {
				const next = new Set(prev);
				if (next.has(behaviorId)) {
					next.delete(behaviorId);
				} else {
					next.add(behaviorId);
				}
				try {
					localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
				} catch { /* ignore */ }
				return next;
			});
		},
		[storageKey],
	);

	const reviewedCount = useMemo(() => reviewedIds.size, [reviewedIds]);

	return { isReviewed, toggleReviewed, reviewedCount };
}
