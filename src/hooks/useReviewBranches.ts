import useSWR from "swr";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReviewBranches(sessionId: string) {
	const { data, error } = useSWR<{ branches: string[] }>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}/branches` : null,
		fetcher,
		{ revalidateOnFocus: false },
	);

	return {
		branches: data?.branches ?? [],
		error,
	};
}
