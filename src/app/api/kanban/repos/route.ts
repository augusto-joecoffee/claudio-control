import { getAllKanbanConfigs } from "@/lib/kanban-store";
import { getAllRepoEntries } from "@/lib/repo-registry";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Returns a list of repo entries that have kanban enabled (at least one column). */
export async function GET() {
  const [configs, entries] = await Promise.all([getAllKanbanConfigs(), getAllRepoEntries()]);
  const enabledIds = new Set([...configs.entries()].filter(([, c]) => c.columns.length > 0).map(([id]) => id));
  const repos = entries
    .filter((e) => enabledIds.has(e.id))
    .map((e) => ({ id: e.id, displayName: e.displayName, repoPath: e.repoPath }));
  return NextResponse.json(repos);
}
