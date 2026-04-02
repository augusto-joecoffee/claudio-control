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

	const { data, error, isLoading, mutate } = useSWR<{ diff: string; diffStat: string }>(
		url,
		fetcher,
		{ revalidateOnFocus: false, dedupingInterval: 3000 },
	);

	return {
		diff: data?.diff ?? "",
		diffStat: data?.diffStat ?? "",
		error,
		isLoading,
		refreshDiff: mutate,
	};
}
