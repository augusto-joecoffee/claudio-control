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
    const fromUnstaged = !placement;
    if (!placement) {
      // Use pending prompt (stored at session creation for kanban repos) or fall back to JSONL-extracted prompt
      const pendingPrompt = state.pendingPrompts?.[session.workingDirectory];
      placement = { sessionId, pid: session.pid ?? undefined, columnId: toColumnId, initialPrompt: pendingPrompt ?? session.initialPrompt ?? undefined };
      state.placements.push(placement);
      if (pendingPrompt && state.pendingPrompts) {
        delete state.pendingPrompts[session.workingDirectory];
      }
    }

    const currentColumn = config.columns.find((c) => c.id === placement!.columnId);
    const isIdle = session.status === "idle" || session.status === "waiting" || session.status === "finished";

    if (isIdle || fromUnstaged) {
      // If source column has an output prompt, send it first (card stays until it finishes)
      if (!fromUnstaged && currentColumn && currentColumn.id !== toColumnId && currentColumn.outputPrompt) {
        const outputPromptText = currentColumn.outputPrompt
          .replace(/\{\{initialPrompt\}\}/g, placement.initialPrompt ?? session.initialPrompt ?? "");

        placement.queuedColumnId = toColumnId;
        placement.pendingOutputPrompt = Date.now();
        await saveKanbanState(decoded, state);

        try {
          await sendPromptToSession(session, outputPromptText);
        } catch (err) {
          console.error("Failed to send output prompt:", err);
          placement.queuedColumnId = undefined;
          placement.pendingOutputPrompt = undefined;
          await saveKanbanState(decoded, state);
          return NextResponse.json({ ok: true, queued: false, promptSent: false, error: String(err) });
        }

        return NextResponse.json({ ok: true, queued: true });
      }

      // Extract output from current column (if moving between columns, not from unstaged)
      if (!fromUnstaged && currentColumn && currentColumn.id !== toColumnId) {
        const output = await extractColumnOutput(currentColumn, session);
        if (!state.outputHistory[sessionId]) state.outputHistory[sessionId] = {};
        state.outputHistory[sessionId][currentColumn.id] = output;
        placement.lastOutput = output;
      }

      // Move to target column
      const previousOutput = currentColumn ? state.outputHistory[sessionId]?.[currentColumn.id] : undefined;
      placement.columnId = toColumnId;
      placement.queuedColumnId = undefined;

      const prompt = await buildFullColumnPrompt(targetColumn, previousOutput, session.workingDirectory, placement.initialPrompt ?? session.initialPrompt ?? undefined);
      await saveKanbanState(decoded, state);

      // Fire prompt in background — don't block the response
      if (prompt) {
        sendPromptToSession(session, prompt).catch((err) => console.error("Failed to send prompt:", err));
      }

      return NextResponse.json({ ok: true, queued: false, promptSent: !!prompt });
    }

    // Session is working (and not from unstaged) — queue the move
    placement.queuedColumnId = toColumnId;
    await saveKanbanState(decoded, state);
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    console.error("Kanban move failed:", error);
    return NextResponse.json({ error: "Move failed" }, { status: 500 });
  }
}
