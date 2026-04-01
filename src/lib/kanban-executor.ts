import type { ClaudeSession } from "./types";
import { buildProcessTree, detectAllTmuxPanes, detectTerminal, sendText, typeText } from "./terminal";

/**
 * Send a prompt to an existing Claude Code session via its terminal/tmux pane.
 * Reuses the same detection flow as the "send-message" action.
 */
export async function sendPromptToSession(session: ClaudeSession, prompt: string): Promise<void> {
  if (!session.pid) {
    throw new Error(`Session ${session.id} has no PID — cannot send prompt`);
  }

  console.log(`[kanban-exec] Sending to session ${session.id} (pid ${session.pid}):\n${prompt.slice(0, 200)}`);
  const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
  const info = await detectTerminal(session.pid, tree, panes);
  console.log(`[kanban-exec] Terminal info: tmux=${info.inTmux}, app=${info.app}, tty=${info.tty}`);
  await sendText(info, prompt);
}

/**
 * Type text into a session's message bar WITHOUT submitting.
 * Used to pre-fill the initial prompt for kanban sessions.
 */
export async function typeIntoSession(session: ClaudeSession, text: string): Promise<void> {
  if (!session.pid) {
    throw new Error(`Session ${session.id} has no PID — cannot type`);
  }

  console.log(`[kanban-exec] Typing into session ${session.id} (pid ${session.pid}):\n${text.slice(0, 200)}`);
  const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
  const info = await detectTerminal(session.pid, tree, panes);
  await typeText(info, text);
}
