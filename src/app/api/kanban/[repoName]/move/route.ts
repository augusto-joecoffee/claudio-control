import { discoverSessions } from "@/lib/discovery";
import { buildFullColumnPrompt, extractColumnOutput } from "@/lib/kanban-engine";
import { sendPromptToSession } from "@/lib/kanban-executor";
import { loadKanbanConfig, loadKanbanState, saveKanbanState } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName } = await params;
    const decoded = decodeURIComponent(repoName);
    const { sessionId, toColumnId } = (await request.json()) as {
      sessionId: string;
      toColumnId: string;
    };

    if (!sessionId || !toColumnId) {
      return NextResponse.json({ error: "Missing sessionId or toColumnId" }, { status: 400 });
    }

    const [sessions, config, state] = await Promise.all([
      discoverSessions(),
      loadKanbanConfig(decoded),
      loadKanbanState(decoded),
    ]);

    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const targetColumn = config.columns.find((c) => c.id === toColumnId);
    if (!targetColumn) {
      return NextResponse.json({ error: "Column not found" }, { status: 404 });
    }

    // Find or create placement
    let placement = state.placements.find((p) => p.sessionId === sessionId);
    if (!placement) {
      placement = { sessionId, columnId: toColumnId };
      state.placements.push(placement);
    }

    const currentColumn = config.columns.find((c) => c.id === placement!.columnId);
    const isIdle = session.status === "idle" || session.status === "waiting" || session.status === "finished";

    if (isIdle) {
      // Extract output from current column (if moving from one)
      if (currentColumn && currentColumn.id !== toColumnId) {
        const output = await extractColumnOutput(currentColumn, session);
        if (!state.outputHistory[sessionId]) state.outputHistory[sessionId] = {};
        state.outputHistory[sessionId][currentColumn.id] = output;
        placement.lastOutput = output;
      }

      // Move to target column
      const previousOutput = currentColumn ? state.outputHistory[sessionId]?.[currentColumn.id] : undefined;
      placement.columnId = toColumnId;
      placement.queuedColumnId = undefined;

      // Build and send prompt
      const prompt = await buildFullColumnPrompt(targetColumn, previousOutput, session.workingDirectory, session.initialPrompt ?? undefined);
      await saveKanbanState(decoded, state);

      if (prompt) {
        try {
          await sendPromptToSession(session, prompt);
        } catch (err) {
          console.error("Failed to send prompt to session:", err);
          return NextResponse.json({ ok: true, queued: false, promptSent: false, error: String(err) });
        }
      }

      return NextResponse.json({ ok: true, queued: false, promptSent: !!prompt });
    }

    // Session is working — queue the move
    placement.queuedColumnId = toColumnId;
    await saveKanbanState(decoded, state);
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    console.error("Kanban move failed:", error);
    return NextResponse.json({ error: "Move failed" }, { status: 500 });
  }
}
