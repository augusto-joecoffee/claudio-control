import { mutate } from "swr";

const REFRESH_DELAYS = [200, 500, 1000, 2000];

/** Burst SWR revalidations to catch backend state changes quickly after an action. */
export function refreshAfterAction() {
  // Invalidate the server-side discovery cache immediately so the first
  // SWR revalidation picks up fresh process/session data instead of
  // hitting the stale cache.
  fetch("/api/sessions?fresh=1")
    .then((r) => r.json())
    .then((data) => {
      // Populate SWR cache directly with the fresh result
      mutate("/api/sessions", data, { revalidate: false });
    })
    .catch(() => {});

  // Follow up with burst revalidations to catch any state that settles later
  for (const ms of REFRESH_DELAYS) {
    setTimeout(() => mutate("/api/sessions"), ms);
  }
}

/** Send a keystroke to a Claude session via the API, then refresh. */
export async function sendKeystrokeAction(pid: number, keystroke: string) {
  const response = await fetch("/api/actions/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send-keystroke", pid, keystroke }),
  });
  if (!response.ok) throw new Error(`Keystroke failed: ${response.status}`);
  refreshAfterAction();
}
