import { open, readFile, stat } from "fs/promises";
import {
  HEAD_CHUNK_BYTES_PER_LINE,
  JSONL_HEAD_LINES,
  JSONL_TAIL_LINES,
  PREVIEW_TEXT_MAX_LENGTH,
  TAIL_CHUNK_BYTES_PER_LINE,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
} from "./constants";
import { ConversationMessage, ConversationPreview, TaskSummary, ToolInfo } from "./types";

interface JsonlLine {
  type: string;
  subtype?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stop_reason?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

// Mtime-based cache for JSONL reads — skip re-reading unchanged files
const jsonlCache = new Map<string, { mtimeMs: number; head: JsonlLine[]; tail: JsonlLine[]; mtime: Date }>();

export async function getJsonlMtime(jsonlPath: string): Promise<Date | null> {
  try {
    const s = await stat(jsonlPath);
    return s.mtime;
  } catch {
    return null;
  }
}

async function getJsonlMtimeMs(jsonlPath: string): Promise<number | null> {
  try {
    const s = await stat(jsonlPath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

export async function readJsonlHead(jsonlPath: string, lines = JSONL_HEAD_LINES): Promise<JsonlLine[]> {
  const mtimeMs = await getJsonlMtimeMs(jsonlPath);
  if (mtimeMs !== null) {
    const cached = jsonlCache.get(jsonlPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.head.length > 0) {
      return cached.head;
    }
  }

  try {
    const chunkSize = lines * HEAD_CHUNK_BYTES_PER_LINE;
    const fh = await open(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(chunkSize, (await fh.stat()).size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.toString("utf-8", 0, bytesRead);
      const allLines = text.split("\n").filter(Boolean);
      const headLines = allLines.slice(0, lines);
      const parsed: JsonlLine[] = [];
      for (const line of headLines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // skip
        }
      }
      if (mtimeMs !== null) {
        const existing = jsonlCache.get(jsonlPath);
        jsonlCache.set(jsonlPath, {
          mtimeMs,
          head: parsed,
          tail: existing?.tail ?? [],
          mtime: existing?.mtime ?? new Date(mtimeMs),
        });
      }
      return parsed;
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

export async function readJsonlTail(jsonlPath: string, lines = JSONL_TAIL_LINES): Promise<JsonlLine[]> {
  const mtimeMs = await getJsonlMtimeMs(jsonlPath);
  if (mtimeMs !== null) {
    const cached = jsonlCache.get(jsonlPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.tail.length > 0) {
      return cached.tail;
    }
  }

  try {
    const fh = await open(jsonlPath, "r");
    try {
      const fileSize = (await fh.stat()).size;
      const chunkSize = Math.min(lines * TAIL_CHUNK_BYTES_PER_LINE, fileSize);
      const offset = Math.max(0, fileSize - chunkSize);
      const buf = Buffer.alloc(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      const text = buf.toString("utf-8", 0, bytesRead);
      const allLines = text.split("\n").filter(Boolean);
      const trimmedLines = offset > 0 ? allLines.slice(1) : allLines;
      const tailLines = trimmedLines.slice(-lines);
      const parsed: JsonlLine[] = [];
      for (const line of tailLines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
      if (mtimeMs !== null) {
        const existing = jsonlCache.get(jsonlPath);
        jsonlCache.set(jsonlPath, {
          mtimeMs,
          head: existing?.head ?? [],
          tail: parsed,
          mtime: existing?.mtime ?? new Date(mtimeMs),
        });
      }
      return parsed;
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

export async function readFullConversation(jsonlPath: string): Promise<JsonlLine[]> {
  try {
    const content = await readFile(jsonlPath, "utf-8");
    const allLines = content.trim().split("\n").filter(Boolean);
    const parsed: JsonlLine[] = [];
    for (const line of allLines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export function extractSessionId(lines: JsonlLine[]): string | null {
  for (const line of lines) {
    if (line.sessionId) return line.sessionId;
  }
  return null;
}

export function extractStartedAt(lines: JsonlLine[]): string | null {
  for (const line of lines) {
    if (line.timestamp) return line.timestamp;
  }
  return null;
}

export function extractBranch(lines: JsonlLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].gitBranch) return lines[i].gitBranch!;
  }
  return null;
}

/**
 * Detect system-injected messages in user turns.
 * Claude Code injects XML-tagged content (<system-reminder>, <local-command-caveat>,
 * <command-name>, etc.) that shouldn't appear in the dashboard preview.
 */
function isSystemMessage(text: string): boolean {
  const trimmed = text.trim();
  return /^<[a-zA-Z]/.test(trimmed);
}

/**
 * Strip XML tags from text that may contain mixed user + system content.
 * Returns null if nothing meaningful remains after stripping.
 */
function stripXmlTags(text: string): string | null {
  // Remove matched tag pairs with content, then any remaining/orphan tags
  const stripped = text
    .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

function detectCommandWarnings(name: string, input?: Record<string, unknown>): string[] {
  if (name !== "Bash" || !input || typeof input.command !== "string") return [];
  const cmd = input.command;
  const warnings: string[] = [];
  if (/\$\(/.test(cmd)) warnings.push("Command contains $() command substitution");
  if (/`[^`]+`/.test(cmd)) warnings.push("Command contains backtick substitution");
  if (/\|\s*(sudo|bash|sh|zsh)\b/.test(cmd)) warnings.push("Pipes to shell interpreter");
  if (/\brm\s+(-\w*r|-\w*f)/.test(cmd)) warnings.push("Recursive or forced file deletion");
  if (/\bsudo\b/.test(cmd)) warnings.push("Runs with elevated privileges");
  if (/--force|--hard/.test(cmd)) warnings.push("Uses force/hard flag");
  if (/\beval\b/.test(cmd)) warnings.push("Uses eval");
  return warnings;
}

function summarizeToolInput(name: string, input?: Record<string, unknown>): string | null {
  if (!input) return null;
  switch (name) {
    case "Bash":
      return typeof input.command === "string" ? input.command.slice(0, PREVIEW_TEXT_MAX_LENGTH) : null;
    case "Edit":
    case "Read":
    case "Write":
      return typeof input.file_path === "string" ? input.file_path : null;
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : null;
    case "Grep":
      return typeof input.pattern === "string" ? `/${input.pattern}/` : null;
    case "Skill":
      return typeof input.skill === "string" ? input.skill : null;
    case "Agent":
      return typeof input.description === "string"
        ? input.description
        : typeof input.prompt === "string"
          ? input.prompt.slice(0, PREVIEW_TEXT_MAX_LENGTH)
          : null;
    default: {
      // Fallback: show the first short string value from the input
      for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0 && val.length <= PREVIEW_TEXT_MAX_LENGTH) {
          return val;
        }
      }
      return null;
    }
  }
}

export function extractPreview(lines: JsonlLine[]): ConversationPreview {
  let lastUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  let assistantIsNewer = false;
  let lastTools: ToolInfo[] = [];
  let messageCount = 0;

  for (const line of lines) {
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
    if (!line.message) continue;

    if (line.type === "user" && typeof line.message.content === "string") {
      const text = line.message.content.trim();

      // Detect /clear command — reset preview state
      if (text === "/clear" || text.includes("<command-name>/clear</command-name>")) {
        lastUserMessage = null;
        lastAssistantText = null;
        assistantIsNewer = false;
        lastTools = [];
        messageCount = 0;
        continue;
      }

      // Skip pure system-injected messages (XML tags)
      if (isSystemMessage(text)) {
        const cleaned = stripXmlTags(text);
        if (cleaned) {
          lastUserMessage = cleaned.slice(0, PREVIEW_TEXT_MAX_LENGTH);
          assistantIsNewer = false;
          messageCount++;
        }
        continue;
      }

      lastUserMessage = text.slice(0, PREVIEW_TEXT_MAX_LENGTH);
      assistantIsNewer = false;
      messageCount++;
    } else if (line.type === "assistant" && Array.isArray(line.message.content)) {
      messageCount++;
      const turnTools: ToolInfo[] = [];
      for (const block of line.message.content) {
        if (block.type === "text" && block.text) {
          lastAssistantText = block.text.slice(0, PREVIEW_TEXT_MAX_LENGTH);
        }
        if (block.type === "tool_use" && block.name) {
          turnTools.push({
            name: block.name,
            input: summarizeToolInput(block.name, block.input),
            description: block.input && typeof block.input.description === "string" ? block.input.description : null,
            warnings: detectCommandWarnings(block.name, block.input),
          });
        }
      }
      lastTools = turnTools;
      assistantIsNewer = true;
    }
  }

  return { lastUserMessage, lastAssistantText, assistantIsNewer, lastTools, messageCount };
}

export function linesToConversation(lines: JsonlLine[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
    if (!line.message) continue;

    if (line.type === "user" && typeof line.message.content === "string") {
      const rawText = line.message.content.trim();
      // System-injected messages start with XML tags — strip them but keep user content
      let text: string | null = rawText;
      if (isSystemMessage(rawText)) {
        text = stripXmlTags(rawText);
        if (!text) continue; // Pure system message with no user content
      }

      messages.push({
        type: "user",
        timestamp: line.timestamp || "",
        text,
        toolUses: [],
      });
    } else if (line.type === "assistant" && Array.isArray(line.message.content)) {
      let text: string | null = null;
      const toolUses: { name: string; input?: Record<string, unknown> }[] = [];
      for (const block of line.message.content) {
        if (block.type === "text" && block.text) {
          text = (text ? text + "\n" : "") + block.text;
        }
        if (block.type === "tool_use" && block.name) {
          toolUses.push({ name: block.name, input: block.input });
        }
      }
      messages.push({
        type: "assistant",
        timestamp: line.timestamp || "",
        text,
        toolUses,
        stopReason: line.message.stop_reason ?? null,
      });
    }
  }

  return messages;
}

/**
 * Returns the stop_reason from the last assistant message.
 * "end_turn" = Claude chose to stop, "tool_use" = calling a tool, "max_tokens" = cut off.
 */
export function extractLastStopReason(lines: JsonlLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
    if (!line.message) continue;
    if (line.type === "assistant" && line.message.stop_reason) {
      return line.message.stop_reason;
    }
    break;
  }
  return null;
}

export function lastMessageHasError(lines: JsonlLine[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
    if (!line.message) continue;

    if (line.type === "assistant" && Array.isArray(line.message.content)) {
      for (const block of line.message.content) {
        if (block.type === "text" && block.text) {
          // Check the first ~500 chars only — actual error reports appear at the
          // start of the message, not buried in large JSON/code output. This
          // avoids false positives from domain terms like "payout_failed".
          const snippet = block.text.slice(0, 500).toLowerCase();
          if (snippet.includes("error") && snippet.includes("failed")) return true;
        }
      }
    }
    break;
  }
  return false;
}

/**
 * Checks if the last assistant message issued a tool_use but no tool_result
 * has come back yet. This means the CLI is waiting for the user to approve
 * the tool execution (permission prompt).
 */
export function hasPendingToolUse(lines: JsonlLine[]): boolean {
  // Walk backwards to find the last meaningful message
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
    if (!line.message) continue;

    // If last message is assistant with tool_use → pending (waiting for approval)
    if (line.type === "assistant" && Array.isArray(line.message.content)) {
      return line.message.content.some((b) => b.type === "tool_use");
    }

    // If last message is user (could be tool_result or new input) → not pending
    return false;
  }
  return false;
}

/**
 * Checks if the last assistant message is genuinely asking for a decision or
 * permission mid-task. Excludes generic greetings and "how can I help" responses.
 */
export function isAskingForInput(lines: JsonlLine[]): boolean {
  // Find the last assistant message and count how many assistant turns preceded it
  let lastAssistant: JsonlLine | null = null;
  let assistantTurnCount = 0;
  let hasToolUseInSession = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;

    if (line.type === "assistant" && line.message && Array.isArray(line.message.content)) {
      assistantTurnCount++;
      if (!lastAssistant) lastAssistant = line;
      if (line.message.content.some((b) => b.type === "tool_use")) {
        hasToolUseInSession = true;
      }
    }
    // If we hit a user message before finding an assistant message, Claude isn't the last speaker
    if (line.type === "user" && !lastAssistant) return false;
  }

  if (!lastAssistant || !lastAssistant.message) return false;

  const content = lastAssistant.message.content;
  if (!Array.isArray(content)) return false;

  // If the last message itself has tool_use blocks, Claude is working, not asking
  const hasToolUse = content.some((b) => b.type === "tool_use");
  if (hasToolUse) return false;

  // Must be end_turn
  if (lastAssistant.message.stop_reason !== "end_turn") return false;

  // If this is the first assistant turn and no tools were used in the session,
  // it's just an initial greeting/response — not a mid-task question
  if (assistantTurnCount <= 1 && !hasToolUseInSession) return false;

  const textBlocks = content.filter((b) => b.type === "text" && b.text);
  if (textBlocks.length === 0) return false;

  const fullText = textBlocks.map((b) => b.text || "").join("\n");
  const lower = fullText.toLowerCase();

  // Filter out generic greeting/help-offer patterns
  const greetingPatterns = [
    /^(hey|hi|hello)[\s!.,]*what can i help/i,
    /^(hey|hi|hello)[\s!.,]*how can i (help|assist)/i,
    /what (can|would you like me to|shall) i help.*with/i,
    /how can i (help|assist) you/i,
  ];
  for (const pattern of greetingPatterns) {
    if (pattern.test(fullText.trim())) return false;
  }

  // Look for strong decision/permission/confirmation patterns
  if (lower.includes("shall i proceed") || lower.includes("should i proceed")) return true;
  if (lower.includes("shall i go ahead") || lower.includes("should i go ahead")) return true;
  if (lower.includes("would you like me to")) return true;
  if (lower.includes("please confirm")) return true;
  if (lower.includes("which approach") || lower.includes("which option")) return true;
  if (lower.includes("do you want me to")) return true;
  if (lower.includes("what should claude do instead")) return true;
  if (lower.includes("interrupted")) return true;
  if (lower.includes("before i ") && fullText.includes("?")) return true;
  if (lower.includes("is that okay") || lower.includes("does that look right")) return true;
  if (
    lower.includes("let me know") &&
    (lower.includes("prefer") || lower.includes("choose") || lower.includes("decision"))
  )
    return true;

  return false;
}

/**
 * Extract a task summary from the early conversation.
 * Looks for Linear issue data in tool results, falls back to first user message.
 */
export function extractTaskSummary(headLines: JsonlLine[]): TaskSummary | null {
  // Strategy 1: Find a Linear issue in tool_result content blocks
  for (const line of headLines) {
    if (line.type !== "user" || !line.message) continue;
    const content = line.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== "tool_result") continue;
      // tool_result content can be a nested array with text blocks
      const innerContent = (block as Record<string, unknown>).content;
      if (!Array.isArray(innerContent)) continue;

      for (const inner of innerContent as Array<Record<string, unknown>>) {
        if (inner.type !== "text" || typeof inner.text !== "string") continue;
        try {
          const data = JSON.parse(inner.text as string);
          if (data.title && (data.identifier || data.id)) {
            let desc = data.description || null;
            if (desc) {
              desc = desc
                .replace(/\\n/g, "\n")
                .replace(/\n+/g, " · ")
                .replace(/^\s*\*\s*/g, "")
                .replace(/\s*\*\s*/g, " · ")
                .trim();
              if (desc.length > 300) desc = desc.slice(0, 297) + "...";
            }
            return {
              title: data.title,
              description: desc,
              source: "linear",
              ticketId: data.identifier || data.id,
              ticketUrl: data.url || null,
            };
          }
        } catch {
          // Not JSON or not a Linear issue
        }
      }
    }
  }

  // Strategy 2: Fall back to first user message (if it's not a generic prompt)
  for (const line of headLines) {
    if (line.type !== "user" || !line.message) continue;
    const content = line.message.content;
    if (typeof content !== "string") continue;
    let text = content.trim();
    if (!text) continue;

    // Skip system-injected messages; try stripping XML tags for mixed content
    if (isSystemMessage(text)) {
      const cleaned = stripXmlTags(text);
      if (!cleaned) continue;
      text = cleaned;
    }

    const generic = /^(implement|start|work on|fix|do)\s+(the\s+)?(linear|referenced|ticket)/i;
    if (generic.test(text) && text.length < 100) continue;

    const textLines = text.split("\n").filter((l: string) => l.trim());
    const rawTitle = textLines[0].replace(/^#+\s*/, "");
    const title =
      rawTitle.length > TASK_TITLE_MAX_LENGTH ? rawTitle.slice(0, TASK_TITLE_MAX_LENGTH - 3) + "..." : rawTitle;
    const rawDesc = textLines.length > 1 ? textLines.slice(1).join(" ") : null;
    const description = rawDesc
      ? rawDesc.length > TASK_DESCRIPTION_MAX_LENGTH
        ? rawDesc.slice(0, TASK_DESCRIPTION_MAX_LENGTH - 3) + "..."
        : rawDesc
      : null;

    return {
      title,
      description,
      source: "prompt",
      ticketId: null,
      ticketUrl: null,
    };
  }

  return null;
}

/**
 * Extract the full initial prompt text from the early conversation lines.
 * Returns the complete first user message (not truncated), or null if none found.
 */
export function extractInitialPrompt(headLines: JsonlLine[]): string | null {
  for (const line of headLines) {
    if (line.type !== "user" || !line.message) continue;
    const content = line.message.content;
    if (typeof content !== "string") continue;
    let text = content.trim();
    if (!text) continue;

    if (isSystemMessage(text)) {
      const cleaned = stripXmlTags(text);
      if (!cleaned) continue;
      text = cleaned;
    }

    return text;
  }
  return null;
}

// ── JSONL byte-offset completion tracking ──

export interface JsonlCompletionStatus {
  /** Whether a user message (our prompt) appeared after the recorded offset. */
  promptReceived: boolean;
  /** Whether the last assistant message has stop_reason "end_turn" with no pending tool calls. */
  isComplete: boolean;
  /** Whether Claude is mid-tool-chain (stop_reason "tool_use" or awaiting tool_result). */
  isMidToolChain: boolean;
  /** Whether Claude has a pending tool_use waiting for approval or is asking for user input. */
  isWaiting: boolean;
  /** Whether stop_reason is "max_tokens" (response cut off). */
  isMaxTokens: boolean;
  /** Current JSONL file size (for reference). */
  currentFileSize: number;
}

/**
 * Read JSONL content written after `byteOffset` and determine whether a sent
 * prompt has been received and completed by Claude.
 *
 * Returns null if no new data has been written since the offset, or if the
 * file has been truncated/rotated (size < offset).
 */
export async function checkJsonlCompletion(
  jsonlPath: string,
  byteOffset: number,
): Promise<JsonlCompletionStatus | null> {
  let fh;
  try {
    fh = await open(jsonlPath, "r");
    const fileSize = (await fh.stat()).size;

    if (fileSize <= byteOffset) {
      return null; // No new data (or file truncated)
    }

    const readSize = fileSize - byteOffset;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, byteOffset);

    const text = buf.toString("utf-8");
    const rawLines = text.split("\n").filter(Boolean);

    // First line may be partial if byteOffset landed mid-line — try to parse all,
    // discard any that fail.
    const lines: JsonlLine[] = [];
    for (const raw of rawLines) {
      try { lines.push(JSON.parse(raw)); } catch { /* skip partial/malformed */ }
    }

    if (lines.length === 0) {
      return null;
    }

    // Check if our prompt was received (any user message in new content)
    let promptReceived = false;
    for (const line of lines) {
      if (line.type === "user" && line.message) {
        promptReceived = true;
        break;
      }
    }

    // Walk backwards to find the last meaningful message
    let isComplete = false;
    let isMidToolChain = false;
    let isWaiting = false;
    let isMaxTokens = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.type === "progress" || line.type === "file-history-snapshot" || line.type === "system") continue;
      if (!line.message) continue;

      if (line.type === "assistant") {
        const stopReason = line.message.stop_reason;
        const hasToolUseBlock = Array.isArray(line.message.content) &&
          line.message.content.some((b) => b.type === "tool_use");

        if (stopReason === "end_turn") {
          if (hasToolUseBlock) {
            // end_turn but with tool_use blocks = pending approval
            isWaiting = true;
          } else {
            isComplete = true;
          }
        } else if (stopReason === "tool_use") {
          // Claude called a tool — mid-chain. Check if it's pending approval
          // (no subsequent tool_result) or being auto-executed.
          isMidToolChain = true;
        } else if (stopReason === "max_tokens") {
          isMaxTokens = true;
        }
        break;
      }

      if (line.type === "user") {
        // Last meaningful message is a user message (tool_result or new input).
        // If it's a tool_result, Claude is processing it — mid-chain.
        if (Array.isArray(line.message.content)) {
          isMidToolChain = true;
        }
        // If it's a string (user text), the prompt was received but Claude
        // hasn't responded yet — still mid-chain from our perspective.
        else {
          isMidToolChain = true;
        }
        break;
      }

      break;
    }

    return {
      promptReceived,
      isComplete,
      isMidToolChain,
      isWaiting,
      isMaxTokens,
      currentFileSize: fileSize,
    };
  } catch {
    return null; // File doesn't exist or can't be read
  } finally {
    await fh?.close();
  }
}
