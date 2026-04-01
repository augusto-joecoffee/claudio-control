"use client";

import { useKanbanConfig } from "@/hooks/useKanbanConfig";
import type { ClaudeSession } from "@/lib/types";
import type { ReactNode } from "react";
import { KanbanGroupView } from "./KanbanGroupView";

interface Props {
  repoId: string;
  sessions: ClaudeSession[];
  renderCard: (session: ClaudeSession) => ReactNode;
  fallback: ReactNode; // rendered when kanban is not configured
}

/**
 * Checks if a repo group has kanban columns configured.
 * If yes, renders KanbanGroupView. If no, renders the fallback (normal grid/list).
 */
export function KanbanAwareGroup({ repoId, sessions, renderCard, fallback }: Props) {
  const { config } = useKanbanConfig(repoId);

  if (config && config.columns.length > 0) {
    return <KanbanGroupView repoId={repoId} sessions={sessions} renderCard={renderCard} />;
  }

  return <>{fallback}</>;
}
