import { useEffect, useRef } from "react";
import useSWR from "swr";

const fetcher = (url: string) =>
	fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${r.status}`);
		return r.json();
	});

/**
 * Polls a lightweight fingerprint endpoint and calls `onChanged` when the
 * diff state changes.  The full diff is only fetched when something actually
 * changed, keeping idle overhead minimal.
 */
export function useAutoRefreshDiff(
	sessionId: string,
	onChanged: () => void,
	{ enabled = true, interval = 2000 }: { enabled?: boolean; interval?: number } = {},
) {
	const url = sessionId && enabled
		? `/api/review/${encodeURIComponent(sessionId)}/diff/check`
		: null;

	const { data } = useSWR<{ fingerprint: string }>(url, fetcher, {
		refreshInterval: interval,
		revalidateOnFocus: false,
		dedupingInterval: interval - 200,
	});

	const prevRef = useRef<string | null>(null);
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	useEffect(() => {
		if (!data?.fingerprint) return;

		// Skip the very first fingerprint — it's the initial state, not a change.
		if (prevRef.current === null) {
			prevRef.current = data.fingerprint;
			return;
		}

		if (data.fingerprint !== prevRef.current) {
			prevRef.current = data.fingerprint;
			onChangedRef.current();
		}
	}, [data?.fingerprint]);
}
