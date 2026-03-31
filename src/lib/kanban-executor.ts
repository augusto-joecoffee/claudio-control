import type { ClaudeSession } from "./types";
import { buildProcessTree, detectAllTmuxPanes, detectTerminal, sendText } from "./terminal";

/**
 * Send a prompt to an existing Claude Code session via its terminal/tmux pane.
 * Reuses the same detection flow as the "send-message" action.
 */
export async function sendPromptToSession(session: ClaudeSession, prompt: string): Promise<void> {
  if (!session.pid) {
    throw new Error(`Session ${session.id} has no PID — cannot send prompt`);
  }

  const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
  const info = await detectTerminal(session.pid, tree, panes);
  await sendText(info, prompt);
}
