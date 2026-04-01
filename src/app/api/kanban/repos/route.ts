import { getAllKanbanConfigs } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Returns a list of repo names that have kanban enabled (at least one column). */
export async function GET() {
  const configs = await getAllKanbanConfigs();
  const repos = [...configs.keys()];
  return NextResponse.json(repos);
}
