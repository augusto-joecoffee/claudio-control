import { discoverSessions } from "@/lib/discovery";
import { typeIntoSession } from "@/lib/kanban-executor";
import { loadKanbanState, saveKanbanState } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Types a pending prompt into a session's message bar (without submitting).
 * Called after session creation for kanban-enabled repos.
 */
export async function POST(request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName: repoId } = await params;
    const decoded = decodeURIComponent(repoId);
    const { workingDirectory } = (await request.json()) as { workingDirectory: string };

    const state = await loadKanbanState(decoded);
    const prompt = state.pendingPrompts?.[workingDirectory];
    if (!prompt) {
      return NextResponse.json({ ok: true, typed: false, reason: "no pending prompt" });
    }

    // Don't type if the session already has a column placement — the column workflow handles it
    const sessions = await discoverSessions();
    const matchSession = sessions.find((s) => s.workingDirectory === workingDirectory);
    if (matchSession && state.placements.some((p) => p.sessionId === matchSession.id)) {
      return NextResponse.json({ ok: true, typed: false, reason: "session already in column" });
    }

    // Find the session by working directory
    const session = sessions.find((s) => s.workingDirectory === workingDirectory);
    if (!session) {
      return NextResponse.json({ ok: true, typed: false, reason: "session not found yet" });
    }

    if (session.status !== "idle") {
      return NextResponse.json({ ok: true, typed: false, reason: "session not idle" });
    }

    await typeIntoSession(session, prompt);
    return NextResponse.json({ ok: true, typed: true });
  } catch (error) {
    console.error("Type prompt failed:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
