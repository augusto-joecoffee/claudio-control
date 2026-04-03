import useSWR from "swr";
import type { ReviewComment, ReviewSession } from "@/lib/types";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useReview(sessionId: string) {
	const { data, error, isLoading, mutate } = useSWR<ReviewSession>(
		sessionId ? `/api/review/${encodeURIComponent(sessionId)}` : null,
		fetcher,
		{ revalidateOnFocus: false, dedupingInterval: 2000 },
	);

	const addComment = async (filePath: string, line: number, content: string, anchorSnippet: string, endLine?: number, parentId?: string, githubThreadId?: string) => {
		const res = await fetch(`/api/review/${encodeURIComponent(sessionId)}/comments`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filePath, line, content, anchorSnippet, endLine, parentId, githubThreadId }),
		});
		if (!res.ok) throw new Error("Failed to add comment");
		const { comment } = (await res.json()) as { comment: ReviewComment };

		// Optimistic update — append the new comment locally instead of full refetch
		await mutate(
			(current) => {
				if (!current) return current;
				return { ...current, comments: [...current.comments, comment] };
			},
			{ revalidate: false },
		);

		return comment;
	};

	return {
		review: data ?? null,
		comments: data?.comments ?? [],
		error,
		isLoading,
		refresh: mutate,
		addComment,
	};
}
