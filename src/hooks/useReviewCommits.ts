import useSWR from "swr";

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
}

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReviewCommits(sessionId: string) {
	const { data, error } = useSWR<{ commits: CommitInfo[] }>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}/commits` : null,
		fetcher,
		{ revalidateOnFocus: false },
	);

	return {
		commits: data?.commits ?? [],
		error,
	};
}
