import { useCallback } from "react";
import useSWR from "swr";
import type { GitHubReviewComment } from "@/lib/types";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useGitHubComments(sessionId: string, prUrl?: string | null) {
	const url = sessionId && prUrl
		? `/api/review/${encodeURIComponent(sessionId)}/github-comments`
		: null;

	const { data, error, isLoading, mutate } = useSWR<{ comments: GitHubReviewComment[] }>(
		url,
		fetcher,
		{ refreshInterval: 30_000, revalidateOnFocus: false, dedupingInterval: 10_000 },
	);

	const replyToThread = useCallback(async (threadId: string, body: string) => {
		const res = await fetch(`/api/review/${encodeURIComponent(sessionId)}/github-comments/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ threadId, body }),
		});
		if (!res.ok) throw new Error("Failed to reply");
		await mutate();
		return res.json();
	}, [sessionId, mutate]);

	const resolveThread = useCallback(async (threadId: string) => {
		const res = await fetch(`/api/review/${encodeURIComponent(sessionId)}/github-comments/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ threadId }),
		});
		if (!res.ok) throw new Error("Failed to resolve");
		await mutate();
	}, [sessionId, mutate]);

	return {
		comments: data?.comments ?? [],
		error,
		isLoading,
		refresh: mutate,
		replyToThread,
		resolveThread,
	};
}
