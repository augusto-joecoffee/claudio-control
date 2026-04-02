import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";

interface QueueStatus {
	processingId: string | null;
	pendingCount: number;
	completedCount: number;
	sessionStatus: string;
	justResolved: string | null;
}

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReviewQueue(
	sessionId: string,
	opts: {
		onCommentResolved?: (commentId: string) => void;
		paused?: boolean;
	} = {},
) {
	const { paused, onCommentResolved } = opts;

	const { data, error, mutate } = useSWR<QueueStatus>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}/queue` : null,
		fetcher,
		{
			// Only poll when there's active work (pending or processing comments)
			refreshInterval: (latestData: QueueStatus | undefined) => {
				if (!latestData) return 2000; // Initial load
				if (latestData.processingId || latestData.pendingCount > 0) return 2000;
				return 5000; // Idle — poll slowly as safety net
			},
			revalidateOnFocus: false,
			dedupingInterval: 1000,
		},
	);

	const lastResolvedRef = useRef<string | null>(null);
	const onCommentResolvedRef = useRef(onCommentResolved);
	onCommentResolvedRef.current = onCommentResolved;

	// Fire callback when a comment gets resolved
	useEffect(() => {
		if (data?.justResolved && data.justResolved !== lastResolvedRef.current) {
			lastResolvedRef.current = data.justResolved;
			onCommentResolvedRef.current?.(data.justResolved);
		}
	}, [data?.justResolved]);

	// Auto-send next pending comment when queue is idle
	useEffect(() => {
		if (paused) return;
		if (!data) return;
		if (data.processingId) return;
		if (data.pendingCount === 0) return;
		if (data.sessionStatus !== "idle" && data.sessionStatus !== "waiting") return;

		let cancelled = false;
		(async () => {
			try {
				await fetch(`/api/review/${encodeURIComponent(sessionId)}/queue`, {
					method: "POST",
				});
				if (!cancelled) await mutate();
			} catch (err) {
				console.error("Failed to send next comment:", err);
			}
		})();

		return () => { cancelled = true; };
	}, [data?.processingId, data?.pendingCount, data?.sessionStatus, sessionId, paused, mutate]);

	const sendNext = useCallback(async () => {
		await fetch(`/api/review/${encodeURIComponent(sessionId)}/queue`, { method: "POST" });
		await mutate();
	}, [sessionId, mutate]);

	return {
		processingId: data?.processingId ?? null,
		pendingCount: data?.pendingCount ?? 0,
		completedCount: data?.completedCount ?? 0,
		sessionStatus: data?.sessionStatus ?? "unknown",
		error,
		refresh: mutate,
		sendNext,
	};
}
