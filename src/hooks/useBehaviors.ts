import { useCallback } from "react";
import useSWR from "swr";
import type { BehaviorAnalysis } from "@/lib/types";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

type BehaviorResponse = BehaviorAnalysis & {
	stale: boolean;
	status?: "complete";
};

export function useBehaviors(sessionId: string, enabled: boolean) {
	const url =
		sessionId && enabled ? `/api/review/${encodeURIComponent(sessionId)}/behaviors` : null;

	const { data, error, isLoading, mutate } = useSWR<BehaviorResponse>(url, fetcher, {
		revalidateOnFocus: false,
		dedupingInterval: 1000,
	});

	const refresh = useCallback(async () => {
		if (!sessionId) return;
		await fetch(`/api/review/${encodeURIComponent(sessionId)}/behaviors/refresh`, {
			method: "POST",
		});
		await mutate();
	}, [sessionId, mutate]);

	return {
		behaviors: data?.behaviors ?? [],
		orphanedSymbols: data?.orphanedSymbols ?? [],
		warnings: data?.warnings ?? [],
		analysisTimeMs: data?.analysisTimeMs ?? 0,
		isLoading,
		isAnalyzing: false,
		isStale: data?.stale ?? false,
		error,
		refresh,
	};
}
