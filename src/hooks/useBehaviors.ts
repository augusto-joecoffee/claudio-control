import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";
import type { BehaviorAnalysis } from "@/lib/types";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

type BehaviorResponse = BehaviorAnalysis & {
	stale: boolean;
	status?: "pending" | "processing" | "complete" | "error";
};

export function useBehaviors(sessionId: string, enabled: boolean) {
	const url =
		sessionId && enabled ? `/api/review/${encodeURIComponent(sessionId)}/behaviors` : null;

	const { data, error, isLoading, mutate } = useSWR<BehaviorResponse>(url, fetcher, {
		revalidateOnFocus: false,
		// Poll faster when processing, slower otherwise
		refreshInterval: (latestData: BehaviorResponse | undefined) => {
			if (!latestData) return 3000;
			if (latestData.status === "processing") return 2000; // Active polling
			if (latestData.status === "pending") return 0; // Don't poll, will trigger analyze
			return 0; // Complete — stop polling
		},
		dedupingInterval: 1000,
	});

	const analyzeTriggered = useRef(false);

	// Auto-trigger analysis when status is "pending"
	useEffect(() => {
		if (!data || !sessionId || !enabled) return;
		if (data.status !== "pending") {
			analyzeTriggered.current = false;
			return;
		}
		if (analyzeTriggered.current) return; // Don't trigger twice

		analyzeTriggered.current = true;

		fetch(`/api/review/${encodeURIComponent(sessionId)}/behaviors/analyze`, {
			method: "POST",
		})
			.then(() => mutate()) // Refresh to get "processing" status
			.catch(() => { analyzeTriggered.current = false; });
	}, [data?.status, sessionId, enabled, mutate]);

	const refresh = useCallback(async () => {
		if (!sessionId) return;
		// Trigger a fresh analysis
		analyzeTriggered.current = false;
		await fetch(`/api/review/${encodeURIComponent(sessionId)}/behaviors/analyze`, {
			method: "POST",
		});
		await mutate();
	}, [sessionId, mutate]);

	const isAnalyzing = data?.status === "processing";
	const isPending = data?.status === "pending";

	return {
		behaviors: data?.behaviors ?? [],
		orphanedSymbols: data?.orphanedSymbols ?? [],
		warnings: data?.warnings ?? [],
		analysisTimeMs: data?.analysisTimeMs ?? 0,
		isLoading: isLoading || isPending,
		isAnalyzing,
		isStale: data?.stale ?? false,
		error,
		refresh,
	};
}
