import { useCallback } from "react";
import useSWR from "swr";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReviewDiff(sessionId: string, commit: string = "all") {
	const url = sessionId
		? `/api/review/${encodeURIComponent(sessionId)}/diff${commit !== "all" ? `?commit=${encodeURIComponent(commit)}` : ""}`
		: null;

	const { data, error, isLoading, mutate } = useSWR<{ diff: string; diffStat: string; uncommittedFiles?: string[] }>(
		url,
		fetcher,
		{ revalidateOnFocus: false, dedupingInterval: 3000 },
	);

	// Fetch directly and update cache — bypasses SWR dedup so
	// post-resolution refreshes always pick up the latest diff.
	const refreshDiff = useCallback(async () => {
		if (!url) return;
		const fresh = await fetcher(url);
		await mutate(fresh, { revalidate: false });
	}, [url, mutate]);

	return {
		diff: data?.diff ?? "",
		diffStat: data?.diffStat ?? "",
		uncommittedFiles: data?.uncommittedFiles ?? [],
		error,
		isLoading,
		refreshDiff,
	};
}
