"use client";

import type { ClaudeSession } from "@/lib/types";
import { useEffect, useRef } from "react";

/**
 * Watches sessions for idle transitions and triggers kanban tick processing.
 * When a session's status changes from "working" to "idle"/"finished",
 * calls the tick endpoint to process queued moves and auto-cascades.
 */
export function useKanbanTick(
  repoName: string | null,
  sessions: ClaudeSession[],
  onTickComplete?: () => void,
) {
  const previousStatuses = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!repoName || sessions.length === 0) return;

    const prev = previousStatuses.current;
    let shouldTick = false;

    for (const session of sessions) {
      const prevStatus = prev.get(session.id);
      if (prevStatus && prevStatus !== session.status) {
        // Session transitioned — check if it went idle
        if (
          (prevStatus === "working" || prevStatus === "waiting") &&
          (session.status === "idle" || session.status === "finished")
        ) {
          shouldTick = true;
        }
      }
      prev.set(session.id, session.status);
    }

    if (shouldTick) {
      fetch(`/api/kanban/${encodeURIComponent(repoName)}/tick`, { method: "POST" })
        .then(() => onTickComplete?.())
        .catch((err) => console.error("Kanban tick failed:", err));
    }
  }, [repoName, sessions, onTickComplete]);
}
