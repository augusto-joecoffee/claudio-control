"use client";

import type { KanbanColumn, KanbanConfig } from "@/lib/types";
import { useCallback, useRef, useState } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useKanbanConfig(repoId: string | null) {
  const key = repoId ? `/api/kanban/${encodeURIComponent(repoId)}/config` : null;
  const { data, mutate } = useSWR<KanbanConfig>(key, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  const [localConfig, setLocalConfig] = useState<KanbanConfig | null>(null);
  const initialized = useRef(false);

  const config: KanbanConfig | null = localConfig ?? data ?? null;

  if (data && !initialized.current) {
    initialized.current = true;
    if (!localConfig) setLocalConfig(data);
  }

  const saveToServer = useCallback(
    (updated: KanbanConfig) => {
      if (!repoId) return;
      mutate(updated, false);
      fetch(`/api/kanban/${encodeURIComponent(repoId)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      }).catch((err) => console.error("Failed to save kanban config:", err));
    },
    [repoId, mutate],
  );

  const addColumn = useCallback(
    (column: KanbanColumn) => {
      setLocalConfig((prev) => {
        const next: KanbanConfig = { columns: [...(prev?.columns ?? []), column] };
        saveToServer(next);
        return next;
      });
    },
    [saveToServer],
  );

  const updateColumn = useCallback(
    (columnId: string, updates: Partial<KanbanColumn>) => {
      setLocalConfig((prev) => {
        const columns = (prev?.columns ?? []).map((c) =>
          c.id === columnId ? { ...c, ...updates } : c,
        );
        const next: KanbanConfig = { columns };
        saveToServer(next);
        return next;
      });
    },
    [saveToServer],
  );

  const removeColumn = useCallback(
    (columnId: string) => {
      setLocalConfig((prev) => {
        const columns = (prev?.columns ?? []).filter((c) => c.id !== columnId);
        const next: KanbanConfig = { columns };
        saveToServer(next);
        return next;
      });
    },
    [saveToServer],
  );

  const reorderColumns = useCallback(
    (newOrder: string[]) => {
      setLocalConfig((prev) => {
        const colMap = new Map((prev?.columns ?? []).map((c) => [c.id, c]));
        const columns = newOrder.map((id) => colMap.get(id)!).filter(Boolean);
        const next: KanbanConfig = { columns };
        saveToServer(next);
        return next;
      });
    },
    [saveToServer],
  );

  return { config, addColumn, updateColumn, removeColumn, reorderColumns };
}
