import useSWR from "swr";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReviewDiff(sessionId: string) {
	const { data, error, isLoading, mutate } = useSWR<{ diff: string; diffStat: string }>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}/diff` : null,
		fetcher,
		{ revalidateOnFocus: false },
	);

	return {
		diff: data?.diff ?? "",
		diffStat: data?.diffStat ?? "",
		error,
		isLoading,
		refreshDiff: mutate,
	};
}
