export type ViewMode = "grid" | "list";

export type SessionStatus = "working" | "idle" | "waiting" | "errored" | "finished";

export const statusLabels: Record<SessionStatus, string> = {
  working: "Working",
  idle: "Idle",
  waiting: "Waiting",
  errored: "Error",
  finished: "Finished",
};

export interface ClaudeSession {
  id: string;
  pid: number | null;
  workingDirectory: string;
  repoName: string | null;
  parentRepo: string | null;
  isWorktree: boolean;
  branch: string | null;
  status: SessionStatus;
  lastActivity: string;
  startedAt: string | null;
  git: GitSummary | null;
  preview: ConversationPreview;
  taskSummary: TaskSummary | null;
  initialPrompt: string | null;
  hasPendingToolUse: boolean;
  /** stop_reason from the last assistant message: "end_turn", "tool_use", or "max_tokens". */
  lastStopReason: string | null;
  jsonlPath: string | null;
  prUrl: string | null;
  orphaned: boolean;
  tmuxSession: string | null;
}

export interface GitSummary {
  branch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  untrackedFiles: number;
  shortStat: string;
}

export interface ToolInfo {
  name: string;
  input: string | null;
  description: string | null;
  warnings: string[];
}

export interface ConversationPreview {
  lastUserMessage: string | null;
  lastAssistantText: string | null;
  /** Whether the assistant text came after the last user message */
  assistantIsNewer: boolean;
  lastTools: ToolInfo[];
  messageCount: number;
}

export interface TaskSummary {
  title: string;
  description: string | null;
  source: "linear" | "prompt" | "user";
  ticketId: string | null;
  ticketUrl: string | null;
}

export type PrChecks = "passing" | "failing" | "pending" | "none";
export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface PrStatus {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: PrChecks;
  reviewDecision: PrReviewDecision;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  checksDetail?: { total: number; passing: number; failing: number; pending: number };
  unresolvedThreads: number;
  commentCount: number;
}

export interface SessionDetail extends ClaudeSession {
  conversation: ConversationMessage[];
  gitDiff: string | null;
}

export interface ConversationMessage {
  type: "user" | "assistant";
  timestamp: string;
  text: string | null;
  toolUses: { name: string; input?: Record<string, unknown> }[];
}

export interface SessionGroup {
  repoId: string;
  repoName: string;
  repoPath: string;
  sessions: ClaudeSession[];
}

export interface TerminalEntry {
  sessionId: string;
  workingDirectory: string;
  ptyId: number | null;
  spawnCommand?: string;
  tmuxSession?: string;
  wrapInTmux?: boolean;
  exited: boolean;
}

// ── Kanban Pipeline ──

export interface KanbanColumnInput {
  /** Prompt template sent to the Claude session. Supports {{previousOutput}} and {{initialPrompt}} interpolation. */
  promptTemplate?: string;
  /** File path to read and inject as context. Resolved relative to repo root. */
  filePath?: string;
  /** Shell script whose stdout becomes additional input. Runs in the repo's working directory. */
  script?: string;
}

export interface KanbanColumnOutput {
  /** How to extract output when a session completes in this column. */
  type: "file" | "script" | "git-diff" | "conversation";
  /** For "file": path to read. For "script": command to run. */
  value?: string;
  /** Optional regex to extract a substring from the raw output. */
  regex?: string;
}

export interface KanbanColumn {
  id: string;
  name: string;
  input?: KanbanColumnInput;
  output?: KanbanColumnOutput;
  /** Prompt sent to the session before it leaves this column. Supports {{initialPrompt}}. */
  outputPrompt?: string;
  /** When true, cards auto-move to the next column when their session becomes idle. */
  autoCascade: boolean;
  /** Override the default settle time (ms) before auto-cascade triggers. Default: 30000. */
  settleMs?: number;
  /** When true, auto-cascade only proceeds if the extracted output is non-empty. */
  requireOutput?: boolean;
}

export interface KanbanConfig {
  columns: KanbanColumn[];
}

export interface KanbanCardPlacement {
  sessionId: string;
  /** Stable process ID for re-matching after session ID changes. */
  pid?: number;
  columnId: string;
  /** Target column when moved while session is working. Executed when session goes idle. */
  queuedColumnId?: string;
  /** When true, /clear is sent before the column prompt (first move from unstaged). */
  clearOnMove?: boolean;
  /** Output extracted when the session last completed in this column. */
  lastOutput?: string;
  /** The session's initial prompt, captured when it first enters the kanban. Persisted here because /clear wipes the JSONL source. */
  initialPrompt?: string;
  /** Timestamp (ms) when an output prompt was sent. We wait for the session to finish before moving. */
  pendingOutputPrompt?: number;
  /** Timestamp (ms) when the last prompt was sent to this session via kanban. Cleared on next working transition. */
  promptSentAt?: number;
}

export interface KanbanState {
  placements: KanbanCardPlacement[];
  /** Accumulated outputs per session per column, for passing between pipeline stages. */
  outputHistory: Record<string, Record<string, string>>;
  /** Prompts stored at session creation for kanban-enabled repos (keyed by working directory). */
  pendingPrompts?: Record<string, string>;
}

// ── Code Review ──

export type ReviewCommentStatus = "pending" | "sending" | "processing" | "answered" | "resolved";

export interface ReviewComment {
  id: string;
  filePath: string;
  /** Start line number on the NEW side of the diff. */
  line: number;
  /** End line number for multi-line selections (undefined = single line). */
  endLine?: number;
  /** Original line number when comment was placed (for re-anchoring after edits). */
  originalLine: number;
  /** ~3 lines of surrounding code for fuzzy re-anchoring when lines shift. */
  anchorSnippet: string;
  content: string;
  status: ReviewCommentStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** Claude's response after processing this comment. */
  response: string | null;
  /** If this is a reply, the ID of the parent comment. */
  parentId?: string;
  /** If this comment is a reply to a GitHub PR review thread. */
  githubThreadId?: string;
}

export interface GitHubReviewComment {
  /** GitHub node ID of the comment. */
  id: string;
  /** GitHub node ID of the review thread. */
  threadId: string;
  /** GitHub username of the author. */
  author: string;
  /** Comment body text. */
  body: string;
  /** File path relative to repo root. */
  path: string;
  /** Line number on the new side of the diff. */
  line: number;
  /** Start line for multi-line comments. */
  startLine?: number;
  /** Whether the comment is on outdated code. */
  outdated: boolean;
  createdAt: string;
  /** Direct link to the comment on GitHub. */
  url: string;
  /** Replies within this thread (excluding the root comment). */
  replies: { id: string; author: string; body: string; createdAt: string }[];
}

export interface ReviewSession {
  sessionId: string;
  workingDirectory: string;
  baseBranch: string;
  /** Commit SHA from git merge-base. */
  mergeBase: string;
  comments: ReviewComment[];
  /** Index of the next comment to send to Claude. */
  queueHead: number;
  createdAt: string;
  /** GitHub PR URL if this review is for a PR. */
  prUrl?: string;
}

// ── Behavior-First Review ──

export type ConfidenceLevel = "high" | "medium" | "low";

export type EntrypointKind =
  | "api-route"
  | "event-handler"
  | "queue-consumer"
  | "cli-command"
  | "test-function"
  | "exported-function"
  | "cron-job"
  | "react-component"
  | "unknown";

export type SideEffectKind =
  | "db-write"
  | "db-read"
  | "http-request"
  | "queue-publish"
  | "cache-write"
  | "cache-read"
  | "event-emit"
  | "file-io"
  | "process-exit";

export interface FileLocation {
  /** File path relative to repo root (same format as ReviewComment.filePath). */
  filePath: string;
  /** 1-based line number on NEW side (same as ReviewComment.line). */
  line: number;
  endLine?: number;
  /** True if this location is inside a changed diff hunk. */
  isChanged: boolean;
}

export interface ChangedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "variable" | "type" | "export";
  location: FileLocation;
  /** Fully qualified name: "UserService.handleCreateUser". */
  qualifiedName?: string;
  confidence: ConfidenceLevel;
}

export interface SideEffect {
  kind: SideEffectKind;
  /** Human-readable description, e.g. "prisma.user.create()". */
  description: string;
  location: FileLocation;
  confidence: ConfidenceLevel;
}

export interface CodeSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  /** Source lines — populated on-demand, not persisted in analysis JSON. */
  content?: string;
  language: string;
}

export interface ExecutionStep {
  id: string;
  order: number;
  symbol: ChangedSymbol;
  snippet: CodeSnippet;
  sideEffects: SideEffect[];
  /** Qualified names of downstream symbols this step calls. */
  callsTo: string[];
  /** Why this step is included in the flow. */
  rationale: string;
  /** Whether this step's code was modified by the diff. */
  isChanged: boolean;
  confidence: ConfidenceLevel;
}

export interface ChangedBehavior {
  id: string;
  /** Human-readable name: "POST /api/users → createUser". */
  name: string;
  entrypointKind: EntrypointKind;
  entrypoint: ChangedSymbol;
  steps: ExecutionStep[];
  /** Aggregate side effects across all steps (deduplicated). */
  sideEffects: SideEffect[];
  /** Files touched by this behavior. */
  touchedFiles: string[];
  changedStepCount: number;
  totalStepCount: number;
  confidence: ConfidenceLevel;
  summary?: string;
}

export interface BehaviorAnalysis {
  sessionId: string;
  /** Diff fingerprint at time of analysis, for cache invalidation. */
  diffFingerprint: string;
  behaviors: ChangedBehavior[];
  /** Symbols that changed but could not be traced to any entrypoint. */
  orphanedSymbols: ChangedSymbol[];
  analysisTimeMs: number;
  createdAt: string;
  warnings: string[];
}
