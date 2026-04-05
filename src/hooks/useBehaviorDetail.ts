import useSWR from "swr";
import type { ChangedBehavior } from "@/lib/types";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

export function useBehaviorDetail(sessionId: string, behaviorId: string | null) {
	const url =
		sessionId && behaviorId
			? `/api/review/${encodeURIComponent(sessionId)}/behaviors/${encodeURIComponent(behaviorId)}`
			: null;

	const { data, error, isLoading } = useSWR<ChangedBehavior>(url, fetcher, {
		revalidateOnFocus: false,
		dedupingInterval: 5000,
	});

	return {
		behavior: data ?? null,
		error,
		isLoading,
	};
}
