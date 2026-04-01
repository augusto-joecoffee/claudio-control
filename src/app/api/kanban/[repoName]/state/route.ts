import { discoverSessions } from "@/lib/discovery";
import { loadKanbanState, saveKanbanState } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  const { repoName } = await params;
  const decoded = decodeURIComponent(repoName);
  const state = await loadKanbanState(decoded);

  // Reconcile placements when session IDs change (e.g., after first message writes to JSONL).
  // Match by PID when sessionId no longer exists in discovered sessions.
  const sessions = await discoverSessions();
  const sessionIds = new Set(sessions.map((s) => s.id));
  let reconciled = false;

  for (const placement of state.placements) {
    if (sessionIds.has(placement.sessionId)) continue;
    if (!placement.pid) continue;
    const match = sessions.find((s) => s.pid === placement.pid);
    if (match && match.id !== placement.sessionId) {
      placement.sessionId = match.id;
      reconciled = true;
    }
  }

  if (reconciled) {
    await saveKanbanState(decoded, state);
  }

  return NextResponse.json(state);
}

export async function PUT(request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName } = await params;
    const body = await request.json();
    await saveKanbanState(decodeURIComponent(repoName), body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to save kanban state:", error);
    return NextResponse.json({ error: "Failed to save state" }, { status: 500 });
  }
}
