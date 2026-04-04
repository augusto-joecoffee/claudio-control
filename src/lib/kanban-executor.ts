import { CLEAR_INTER_KEY_MS, CLEAR_LINE_SETTLE_MS, CLEAR_SETTLE_MS, CLEAR_VERIFY_MAX_RETRIES, CLEAR_VERIFY_RETRY_MS } from "./constants";
import type { ClaudeSession } from "./types";
import { buildProcessTree, capturePaneContent, detectAllTmuxPanes, detectTerminal, sendKeystroke, sendText, typeText } from "./terminal";
import type { TerminalInfo } from "./terminal";

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
 * Check whether the Claude Code message bar is empty by reading the tmux pane content.
 * Returns true if empty, false if text is present, null if we can't determine (non-tmux).
 */
async function isMessageBarEmpty(info: TerminalInfo): Promise<boolean | null> {
  const content = await capturePaneContent(info);
  if (content === null) return null;

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];
  // capture-pane -p outputs plain text (no ANSI). The Claude Code input prompt
  // is just ">" or "> " when empty. Any text after the ">" means the bar has content.
  const stripped = lastLine.trimEnd();
  return stripped === ">" || stripped === "> ";
}

/**
 * Clear any text in the session's message bar.
 *
 * For sessions with messages (messageCount > 0): sends two Escape keystrokes
 * (first dismisses dropdowns, second clears text).
 *
 * For zero-message sessions (initial prompt): uses Ctrl+U to clear the input
 * line without triggering Rewind mode, then verifies via tmux capture-pane.
 */
export async function clearMessageBar(session: ClaudeSession): Promise<void> {
  if (!session.pid) {
    throw new Error(`Session ${session.id} has no PID — cannot clear`);
  }

  const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
  const info = await detectTerminal(session.pid, tree, panes);

  if (!session.preview?.messageCount) {
    // Zero-message session: use C-u (Ctrl+U) to clear the input line.
    // Escape would trigger Rewind mode at the initial Claude Code prompt.
    console.log(`[kanban-exec] Clearing line for zero-message session ${session.id} via C-u`);

    await sendKeystroke(info, "C-u");
    await new Promise((r) => setTimeout(r, CLEAR_LINE_SETTLE_MS));

    // Verify the message bar is empty (tmux only — non-tmux trusts timing)
    for (let attempt = 0; attempt < CLEAR_VERIFY_MAX_RETRIES; attempt++) {
      const empty = await isMessageBarEmpty(info);
      if (empty === true) {
        console.log(`[kanban-exec] Verified message bar empty for session ${session.id}`);
        return;
      }
      if (empty === null) {
        console.log(`[kanban-exec] Cannot verify message bar for session ${session.id} (non-tmux), trusting timing`);
        return;
      }
      // Not empty yet — retry
      console.log(`[kanban-exec] Message bar not empty, retry ${attempt + 1} for session ${session.id}`);
      await sendKeystroke(info, "C-u");
      await new Promise((r) => setTimeout(r, CLEAR_VERIFY_RETRY_MS));
    }

    console.warn(`[kanban-exec] Could not verify message bar empty after ${CLEAR_VERIFY_MAX_RETRIES} retries for session ${session.id}`);
    return;
  }

  // Sessions with messages: check if bar is already empty before sending Escape,
  // because Escape on an empty bar triggers Rewind mode in Claude Code.
  const alreadyEmpty = await isMessageBarEmpty(info);
  if (alreadyEmpty === true) {
    console.log(`[kanban-exec] Message bar already empty for session ${session.id}, skipping Escape`);
    return;
  }

  console.log(`[kanban-exec] Clearing message bar for session ${session.id} (pid ${session.pid})`);
  await sendKeystroke(info, "escape");
  await new Promise((r) => setTimeout(r, CLEAR_INTER_KEY_MS));
  await sendKeystroke(info, "escape");
  await new Promise((r) => setTimeout(r, CLEAR_SETTLE_MS));
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
