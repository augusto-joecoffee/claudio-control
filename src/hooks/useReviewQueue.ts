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
	const { data, error, mutate } = useSWR<QueueStatus>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}/queue` : null,
		fetcher,
		{ refreshInterval: 2000, revalidateOnFocus: false },
	);

	const lastResolvedRef = useRef<string | null>(null);

	// Fire callback when a comment gets resolved
	useEffect(() => {
		if (data?.justResolved && data.justResolved !== lastResolvedRef.current) {
			lastResolvedRef.current = data.justResolved;
			opts.onCommentResolved?.(data.justResolved);
		}
	}, [data?.justResolved, opts]);

	// Auto-send next pending comment when queue is idle
	useEffect(() => {
		if (opts.paused) return;
		if (!data) return;
		if (data.processingId) return; // Already processing
		if (data.pendingCount === 0) return; // Nothing to send
		if (data.sessionStatus !== "idle" && data.sessionStatus !== "waiting") return; // Session busy

		const sendNext = async () => {
			try {
				await fetch(`/api/review/${encodeURIComponent(sessionId)}/queue`, {
					method: "POST",
				});
				await mutate();
			} catch (err) {
				console.error("Failed to send next comment:", err);
			}
		};

		sendNext();
	}, [data, sessionId, opts.paused, mutate]);

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
