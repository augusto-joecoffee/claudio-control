"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Diff, Hunk, Decoration, parseDiff, getChangeKey, tokenize } from "react-diff-view";
import type { FileData, ChangeData, HunkData } from "react-diff-view";
import type { GutterOptions, ViewType } from "react-diff-view";
import { refractor as _refractor } from "refractor";

// react-diff-view's tokenize expects highlight() to return an iterable (array of nodes),
// but refractor v5 returns a Root node. Adapt by returning .children.
const refractor = {
	highlight: (code: string, language: string) => _refractor.highlight(code, language).children,
	registered: (lang: string) => _refractor.registered(lang),
};
import type { GitHubReviewComment, ReviewComment } from "@/lib/types";
import { CommentThread } from "./CommentThread";
import { detectFoldRegions, type FoldRegion } from "./fold-detection";
import { applyFolds, type DisplayHunk } from "./fold-hunks";
import "react-diff-view/style/index.css";
import "./syntax-theme.css";

interface DiffViewerProps {
	rawDiff: string;
	viewType: ViewType;
	comments: ReviewComment[];
	activeCommentLocation: { filePath: string; startLine: number; endLine: number } | null;
	onGutterClick: (filePath: string, startLine: number, endLine: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
	githubComments?: GitHubReviewComment[];
	onReplyGitHubComment?: (threadId: string, content: string) => void;
	onResolveGitHubThread?: (threadId: string) => void;
	selectedFile: string | null;
	isViewed?: (path: string) => boolean;
	onToggleViewed?: (path: string) => void;
	sessionId?: string;
	onOpenInEditor?: (filePath: string) => void;
	isLoading?: boolean;
}

function getFilePath(file: FileData): string {
	return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
	html: "markup", htm: "markup", xml: "markup", svg: "markup",
	css: "css", scss: "css", less: "css",
	json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
	sh: "bash", bash: "bash", zsh: "bash",
	md: "markdown", mdx: "markdown",
	sql: "sql", graphql: "graphql", gql: "graphql",
	swift: "swift", dart: "dart", lua: "lua", r: "r",
	dockerfile: "docker", makefile: "makefile",
};

function detectLanguage(filePath: string): string | null {
	const name = filePath.split("/").pop()?.toLowerCase() ?? "";
	if (name === "dockerfile") return "docker";
	if (name === "makefile") return "makefile";
	const ext = name.split(".").pop() ?? "";
	const lang = EXT_TO_LANG[ext];
	if (!lang) return null;
	try {
		if (refractor.registered(lang)) return lang;
	} catch { /* ignore */ }
	return null;
}

function useTokens(hunks: HunkData[], filePath: string) {
	return useMemo(() => {
		const lang = detectLanguage(filePath);
		if (!lang || hunks.length === 0) return undefined;
		try {
			return tokenize(hunks, { highlight: true, refractor, language: lang });
		} catch (e) {
			console.warn("[syntax] tokenize failed for", filePath, e);
			return undefined;
		}
	}, [hunks, filePath]);
}

/** Parse a unified diff and deduplicate entries that share the same file path. */
function parseDiffDeduped(raw: string): FileData[] {
	const parsed = parseDiff(raw, { nearbySequences: "zip" });
	const byPath = new Map<string, FileData>();
	for (const file of parsed) {
		const path = getFilePath(file);
		const existing = byPath.get(path);
		if (existing) {
			existing.hunks = [...existing.hunks, ...file.hunks];
		} else {
			byPath.set(path, { ...file });
		}
	}
	return Array.from(byPath.values());
}

/** Extract ~3 lines of context around a change for comment anchoring. */
function getAnchorSnippet(hunk: HunkData, changeIndex: number): string {
	const changes = hunk.changes;
	const start = Math.max(0, changeIndex - 1);
	const end = Math.min(changes.length, changeIndex + 2);
	return changes
		.slice(start, end)
		.map((c) => c.content)
		.join("\n");
}

/** Extract all lines in a range (with 1 line of context) for multi-line comment anchoring. */
function getRangeAnchorSnippet(hunks: HunkData[], startLine: number, endLine: number): string {
	const lines: string[] = [];
	for (const hunk of hunks) {
		for (const change of hunk.changes) {
			const newLine = change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
			if (newLine !== null && newLine >= startLine - 1 && newLine <= endLine + 1) {
				lines.push(change.content);
			}
		}
	}
	return lines.join("\n");
}

function findChangeIndexByNewLine(hunks: HunkData[], line: number): { hunk: HunkData; index: number } | null {
	for (const hunk of hunks) {
		for (let i = 0; i < hunk.changes.length; i++) {
			const change = hunk.changes[i];
			const newLine = change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
			if (newLine === line) {
				return { hunk, index: i };
			}
		}
	}
	return null;
}

/** Find a change by line number, trying new side first, then old side, then nearest. */
function findChangeByAnyLine(hunks: HunkData[], line: number): { hunk: HunkData; index: number } | null {
	// Try exact match on new side
	const byNew = findChangeIndexByNewLine(hunks, line);
	if (byNew) return byNew;
	// Try exact match on old side
	for (const hunk of hunks) {
		for (let i = 0; i < hunk.changes.length; i++) {
			const change = hunk.changes[i];
			const oldLine = change.type === "normal" ? change.oldLineNumber : change.type === "delete" ? change.lineNumber : null;
			if (oldLine === line) {
				return { hunk, index: i };
			}
		}
	}
	// Fall back to nearest change by new-side line number
	let best: { hunk: HunkData; index: number; dist: number } | null = null;
	for (const hunk of hunks) {
		for (let i = 0; i < hunk.changes.length; i++) {
			const change = hunk.changes[i];
			const newLine = change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
			if (newLine !== null) {
				const dist = Math.abs(newLine - line);
				if (!best || dist < best.dist) best = { hunk, index: i, dist };
			}
		}
	}
	return best ? { hunk: best.hunk, index: best.index } : null;
}

/** Build "normal" change entries from raw file lines for expanding context.
 *  `newStart` is the 1-based line in the new file (used for content + newLineNumber).
 *  `oldStart` is the 1-based line on the old side (may differ due to insertions/deletions). */
function buildNormalChanges(lines: string[], newStart: number, count: number, oldStart?: number): ChangeData[] {
	const changes: ChangeData[] = [];
	const oldBase = oldStart ?? newStart;
	for (let i = 0; i < count; i++) {
		const newLine = newStart + i;
		const oldLine = oldBase + i;
		if (newLine < 1 || newLine > lines.length) continue;
		changes.push({
			type: "normal",
			isNormal: true,
			oldLineNumber: oldLine,
			newLineNumber: newLine,
			content: lines[newLine - 1] ?? "",
		} as ChangeData);
	}
	return changes;
}

const EXPAND_STEP = 20;

const FileDiff = memo(function FileDiff({
	file,
	viewType,
	comments,
	githubComments,
	activeCommentLocation,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
	onResolveComment,
	onDeleteComment,
	onReplyComment,
	onReplyGitHubComment,
	onResolveGitHubThread,
	isViewed,
	onToggleViewed,
	sessionId,
	onOpenInEditor,
}: {
	file: FileData;
	viewType: ViewType;
	comments: ReviewComment[];
	githubComments?: GitHubReviewComment[];
	activeCommentLocation: { filePath: string; startLine: number; endLine: number } | null;
	onGutterClick: (filePath: string, startLine: number, endLine: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
	onReplyGitHubComment?: (threadId: string, content: string) => void;
	onResolveGitHubThread?: (threadId: string) => void;
	isViewed?: boolean;
	onToggleViewed?: () => void;
	sessionId?: string;
	onOpenInEditor?: (filePath: string) => void;
}) {
	const filePath = getFilePath(file);

	// File lines cache for expanding context
	const [fileLines, setFileLines] = useState<string[] | null>(null);
	const [expandedHunks, setExpandedHunks] = useState<HunkData[]>(file.hunks);

	// Reset expanded hunks and fold state when the file changes
	useEffect(() => { setExpandedHunks(file.hunks); setFoldedRegions(new Set()); }, [file.hunks]);

	// --- Code folding ---
	const [foldedRegions, setFoldedRegions] = useState<Set<string>>(new Set());

	const foldRegions = useMemo(() => {
		const allChanges = expandedHunks.flatMap((h) => h.changes);
		return detectFoldRegions(allChanges, detectLanguage(filePath));
	}, [expandedHunks, filePath]);

	const displayHunks = useMemo(
		() => applyFolds(expandedHunks, foldedRegions, foldRegions),
		[expandedHunks, foldedRegions, foldRegions],
	);

	const justHunks = useMemo(() => displayHunks.map((dh) => dh.hunk), [displayHunks]);

	const foldStartMap = useMemo(() => {
		const map = new Map<number, FoldRegion>();
		for (const r of foldRegions) map.set(r.startLine, r);
		return map;
	}, [foldRegions]);

	const toggleFold = useCallback((key: string) => {
		setFoldedRegions((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key); else next.add(key);
			return next;
		});
	}, []);

	// Auto-unfold when a comment targets a folded region
	useEffect(() => {
		if (!activeCommentLocation || activeCommentLocation.filePath !== filePath) return;
		setFoldedRegions((prev) => {
			const next = new Set(prev);
			let changed = false;
			for (const key of prev) {
				const [s, e] = key.split("-").map(Number);
				if (activeCommentLocation.startLine >= s && activeCommentLocation.startLine <= e) {
					next.delete(key);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [activeCommentLocation, filePath]);

	const tokens = useTokens(justHunks, filePath);

	const fetchFileLines = useCallback(async () => {
		if (fileLines || !sessionId) return fileLines;
		try {
			const res = await fetch(`/api/review/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`);
			if (!res.ok) return null;
			const { lines } = await res.json();
			setFileLines(lines);
			return lines as string[];
		} catch { return null; }
	}, [fileLines, sessionId, filePath]);

	const expandUp = useCallback(async (hunkIndex: number) => {
		const lines = await fetchFileLines();
		if (!lines) return;
		setExpandedHunks((prev) => {
			const hunks = prev.map((h) => ({ ...h, changes: [...h.changes] }));
			const hunk = hunks[hunkIndex];
			const firstChange = hunk.changes[0];
			// Get both old and new line numbers for the first change in this hunk
			const firstOld = firstChange?.type === "normal" ? firstChange.oldLineNumber
				: firstChange?.type === "delete" ? firstChange.lineNumber : 1;
			const firstNew = firstChange?.type === "normal" ? firstChange.newLineNumber
				: firstChange?.type === "insert" ? firstChange.lineNumber : 1;

			const prevHunk = hunkIndex > 0 ? hunks[hunkIndex - 1] : null;
			const prevLastChange = prevHunk?.changes[prevHunk.changes.length - 1];
			const prevLastOld = prevLastChange?.type === "normal" ? prevLastChange.oldLineNumber
				: prevLastChange?.type === "insert" ? prevLastChange.lineNumber : 0;
			const prevLastNew = prevLastChange?.type === "normal" ? prevLastChange.newLineNumber
				: prevLastChange?.type === "insert" ? prevLastChange.lineNumber : 0;

			const gapOldStart = prevLastOld + 1;
			const gapNewStart = prevLastNew + 1;
			const gapOldEnd = firstOld - 1;
			const gapNewEnd = firstNew - 1;
			const count = gapNewEnd - gapNewStart + 1;
			const expandCount = Math.min(count, EXPAND_STEP);
			// Expand from the bottom of the gap (closest to the hunk)
			const skipCount = count - expandCount;
			const newChanges = buildNormalChanges(lines, gapNewStart + skipCount, expandCount, gapOldStart + skipCount);
			hunk.changes = [...newChanges, ...hunk.changes];
			hunk.oldStart = gapOldStart + skipCount;
			hunk.newStart = gapNewStart + skipCount;
			return hunks;
		});
	}, [fetchFileLines]);

	const expandDown = useCallback(async (hunkIndex: number) => {
		const lines = await fetchFileLines();
		if (!lines) return;
		setExpandedHunks((prev) => {
			const hunks = prev.map((h) => ({ ...h, changes: [...h.changes] }));
			const hunk = hunks[hunkIndex];
			const lastChange = hunk.changes[hunk.changes.length - 1];
			// Get both old and new line numbers for the last change in this hunk
			const lastOld = lastChange?.type === "normal" ? lastChange.oldLineNumber
				: lastChange?.type === "insert" ? lastChange.lineNumber : 0;
			const lastNew = lastChange?.type === "normal" ? lastChange.newLineNumber
				: lastChange?.type === "insert" ? lastChange.lineNumber : 0;

			const nextHunk = hunkIndex < hunks.length - 1 ? hunks[hunkIndex + 1] : null;
			const nextFirstChange = nextHunk?.changes[0];
			const nextFirstNew = nextFirstChange?.type === "normal" ? nextFirstChange.newLineNumber
				: nextFirstChange?.type === "delete" ? nextFirstChange.lineNumber : lines.length + 1;

			const gapOldStart = lastOld + 1;
			const gapNewStart = lastNew + 1;
			const gapNewEnd = Math.min(nextFirstNew - 1, lines.length);
			const expandCount = Math.min(gapNewEnd - gapNewStart + 1, EXPAND_STEP);
			const newChanges = buildNormalChanges(lines, gapNewStart, expandCount, gapOldStart);
			hunk.changes = [...hunk.changes, ...newChanges];
			return hunks;
		});
	}, [fetchFileLines]);
	const fileComments = useMemo(() => comments.filter((c) => c.filePath === filePath && !c.githubThreadId), [comments, filePath]);
	// Local comments linked to GitHub threads (pending/processing replies)
	const ghThreadReplies = useMemo(() => {
		const map = new Map<string, ReviewComment[]>();
		for (const c of comments) {
			if (c.githubThreadId) {
				const arr = map.get(c.githubThreadId) ?? [];
				arr.push(c);
				map.set(c.githubThreadId, arr);
			}
		}
		return map;
	}, [comments]);
	const oldPath = file.oldPath;
	const fileName = filePath.split("/").pop() ?? "";
	const fileGitHubComments = useMemo(() => (githubComments ?? []).filter((c) => {
		if (c.path === filePath || c.path === oldPath) return true;
		// Fall back to filename match for moved/renamed files
		return fileName !== "" && c.path.endsWith("/" + fileName);
	}), [githubComments, filePath, oldPath, fileName]);
	const fileRef = useRef<HTMLDivElement>(null);

	// Build widgets map: changeKey → ReactNode for inline comments
	const widgets = useMemo(() => {
		const w: Record<string, React.ReactNode> = {};

		// Group local comments by their widget line (endLine for ranges, line for single-line)
		const commentsByWidgetLine = new Map<number, ReviewComment[]>();
		for (const c of fileComments) {
			const widgetLine = c.endLine ?? c.line;
			const existing = commentsByWidgetLine.get(widgetLine) ?? [];
			existing.push(c);
			commentsByWidgetLine.set(widgetLine, existing);
		}

		// Map change keys to GitHub comments (search by new or old line)
		const ghByKey = new Map<string, GitHubReviewComment[]>();
		for (const gc of fileGitHubComments) {
			const result = findChangeByAnyLine(expandedHunks, gc.line);
			if (result) {
				const key = getChangeKey(result.hunk.changes[result.index]);
				const existing = ghByKey.get(key) ?? [];
				existing.push(gc);
				ghByKey.set(key, existing);
			}
		}

		// Build widgets for local comments
		const usedKeys = new Set<string>();
		for (const [widgetLine, lineComments] of commentsByWidgetLine) {
			const result = findChangeIndexByNewLine(expandedHunks, widgetLine);
			if (result) {
				const key = getChangeKey(result.hunk.changes[result.index]);
				usedKeys.add(key);
				const lineGhComments = ghByKey.get(key);
				const isAdding = activeCommentLocation?.filePath === filePath && activeCommentLocation?.endLine === widgetLine;
				w[key] = (
					<CommentThread
						comments={lineComments}
						githubComments={lineGhComments}
						ghThreadReplies={ghThreadReplies}
						isAddingComment={isAdding}
						onSubmitComment={onSubmitComment}
						onCancelComment={onCancelComment}
						onResolveComment={onResolveComment}
						onDeleteComment={onDeleteComment}
						onReplyComment={onReplyComment}
						onReplyGitHubComment={onReplyGitHubComment}
						onResolveGitHubThread={onResolveGitHubThread}
					/>
				);
			}
		}

		// Build widgets for GitHub-only comments (no local comments on same line)
		for (const [key, ghComments] of ghByKey) {
			if (usedKeys.has(key)) continue;
			w[key] = (
				<CommentThread
					comments={[]}
					githubComments={ghComments}
					ghThreadReplies={ghThreadReplies}
					isAddingComment={false}
					onSubmitComment={onSubmitComment}
					onCancelComment={onCancelComment}
					onReplyGitHubComment={onReplyGitHubComment}
					onResolveGitHubThread={onResolveGitHubThread}
				/>
			);
		}

		// Handle the case where we're adding a new comment on a line that has no comments yet
		if (activeCommentLocation?.filePath === filePath) {
			const widgetLine = activeCommentLocation.endLine;
			const hasExistingWidget = commentsByWidgetLine.has(widgetLine) || (() => {
				const r = findChangeIndexByNewLine(expandedHunks, widgetLine);
				return r ? usedKeys.has(getChangeKey(r.hunk.changes[r.index])) || ghByKey.has(getChangeKey(r.hunk.changes[r.index])) : false;
			})();
			if (!hasExistingWidget) {
				const result = findChangeIndexByNewLine(expandedHunks, widgetLine);
				if (result) {
					const key = getChangeKey(result.hunk.changes[result.index]);
					w[key] = (
						<CommentThread
							comments={[]}
							isAddingComment={true}
							onSubmitComment={onSubmitComment}
							onCancelComment={onCancelComment}
						/>
					);
				}
			}
		}

		return w;
	}, [fileComments, fileGitHubComments, activeCommentLocation, filePath, expandedHunks, onSubmitComment, onCancelComment, onResolveComment, onDeleteComment, onReplyComment, onReplyGitHubComment, onResolveGitHubThread]);

	const handleLineClick = useCallback(
		(newLine: number, shiftKey: boolean) => {
			if (shiftKey && activeCommentLocation?.filePath === filePath) {
				// Extend selection from existing start
				const start = Math.min(activeCommentLocation.startLine, newLine);
				const end = Math.max(activeCommentLocation.startLine, newLine);
				const snippet = getRangeAnchorSnippet(expandedHunks, start, end);
				onGutterClick(filePath, start, end, snippet);
			} else {
				// New single-line selection
				const result = findChangeIndexByNewLine(expandedHunks, newLine);
				const snippet = result ? getAnchorSnippet(result.hunk, result.index) : "";
				onGutterClick(filePath, newLine, newLine, snippet);
			}
		},
		[expandedHunks, filePath, onGutterClick, activeCommentLocation],
	);

	// Compute change keys for the selected line range highlight
	const selectedChanges = useMemo(() => {
		if (!activeCommentLocation || activeCommentLocation.filePath !== filePath) return [];
		const keys: string[] = [];
		for (const hunk of expandedHunks) {
			for (const change of hunk.changes) {
				const newLine = change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
				if (newLine !== null && newLine >= activeCommentLocation.startLine && newLine <= activeCommentLocation.endLine) {
					keys.push(getChangeKey(change));
				}
			}
		}
		return keys;
	}, [activeCommentLocation, filePath, expandedHunks]);

	const renderGutter = useCallback(
		({ change, side, renderDefault }: GutterOptions) => {
			if (side === "new" || (viewType === "unified" && change.type !== "delete")) {
				const ln =
					change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
				const foldRegion = ln !== null ? foldStartMap.get(ln) : undefined;
				const foldKey = foldRegion ? `${foldRegion.startLine}-${foldRegion.endLine}` : null;
				const isFolded = foldKey ? foldedRegions.has(foldKey) : false;
				return (
					<span
						className="cursor-pointer hover:bg-violet-500/20 rounded px-0.5 inline-flex items-center gap-0"
						title="Click to comment · Shift+click to select range"
						data-comment-line={ln ?? undefined}
						onClick={(e) => {
							e.stopPropagation();
							if (ln !== null) handleLineClick(ln, e.shiftKey);
						}}
					>
						{foldKey ? (
							<span
								className="diff-fold-toggle"
								title={isFolded ? "Expand block" : "Collapse block"}
								onClick={(e) => { e.stopPropagation(); toggleFold(foldKey); }}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
									{isFolded
										? <path d="M3 1.5 L8 5 L3 8.5Z" />
										: <path d="M1.5 3 L5 8 L8.5 3Z" />
									}
								</svg>
							</span>
						) : (
							<span className="diff-fold-toggle-spacer" />
						)}
						{renderDefault()}
					</span>
				);
			}
			return renderDefault();
		},
		[viewType, handleLineClick, foldStartMap, foldedRegions, toggleFold],
	);

	// Delegate clicks on the gutter <td> to trigger comments even when clicking
	// outside the line number text itself.
	const handleGutterCellClick = useCallback((e: React.MouseEvent) => {
		const td = (e.target as HTMLElement).closest("td.diff-gutter");
		if (!td) return;
		// Don't double-fire if the click was already on the inner span
		const span = td.querySelector("[data-comment-line]") as HTMLElement | null;
		if (!span) return;
		if (span.contains(e.target as Node)) return;
		const line = Number(span.dataset.commentLine);
		if (!Number.isNaN(line)) handleLineClick(line, e.shiftKey);
	}, [handleLineClick]);

	return (
		<div ref={fileRef} id={`file-${filePath}`} className="mb-4 mx-4 first:mt-3">
			{/* File header */}
			<div className="sticky top-0 z-20 px-3 py-1.5 bg-[#161b22] border border-[#21262d] rounded-t-lg flex items-center gap-2">
				<span
					className={`text-[10px] font-bold shrink-0 ${
						file.type === "add" ? "text-emerald-400" : file.type === "delete" ? "text-red-400" : "text-amber-400"
					}`}
				>
					{file.type === "add" ? "NEW" : file.type === "delete" ? "DEL" : "MOD"}
				</span>
				<span
					className="text-xs text-zinc-300 font-mono cursor-pointer hover:text-zinc-100 transition-colors flex-1"
					onClick={() => {
						navigator.clipboard.writeText(filePath);
						onOpenInEditor?.(filePath);
					}}
					title="Click to copy path & open in editor"
				>{filePath}</span>
				{onToggleViewed && (
					<button
						onClick={onToggleViewed}
						className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors ${
							isViewed
								? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
								: "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
						}`}
					>
						<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							{isViewed ? (
								<path d="M4.5 12.75l6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round" fill="none" className="text-emerald-400" />
							) : (
								<rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
							)}
						</svg>
						Viewed
					</button>
				)}
			</div>

			{/* Diff content — collapse when viewed */}
			{!isViewed && <div className="border border-t-0 border-[#21262d] rounded-b-lg diff-viewer-container" style={{ clipPath: "inset(0 round 0 0 0.5rem 0.5rem)" }} onClick={handleGutterCellClick}>
				{justHunks.length > 0 ? (
					<Diff
						viewType={viewType}
						diffType={file.type}
						hunks={justHunks}
						widgets={widgets}
						tokens={tokens}
						selectedChanges={selectedChanges}
						renderGutter={renderGutter}
					>
						{(hunks: HunkData[]) =>
							hunks.flatMap((hunk, idx) => {
								const dh = displayHunks[idx] as DisplayHunk | undefined;
								const origIdx = dh?.originalHunkIndex ?? idx;
								const firstChange = hunk.changes[0];
								const firstLine = firstChange?.type === "normal" ? firstChange.oldLineNumber
									: firstChange?.type === "delete" ? firstChange.lineNumber : 1;

								// Check gap above: between previous hunk's last line and this hunk's first line
								const prevHunk = idx > 0 ? hunks[idx - 1] : null;
								const prevLast = prevHunk?.changes[prevHunk.changes.length - 1];
								const prevLastLine = prevLast?.type === "normal" ? prevLast.oldLineNumber
									: prevLast?.type === "insert" ? prevLast.lineNumber : 0;
								// Don't show expand-up between sub-hunks created by fold splitting
								const prevDh = idx > 0 ? displayHunks[idx - 1] : undefined;
								const isFoldBoundary = prevDh?.foldAfter != null;
								const canExpandUp = !isFoldBoundary && sessionId && (prevHunk ? firstLine > prevLastLine + 1 : firstLine > 1);

								const lastChange = hunk.changes[hunk.changes.length - 1];
								const lastLine = lastChange?.type === "normal" ? lastChange.oldLineNumber
									: lastChange?.type === "insert" ? lastChange.lineNumber : 0;

								// Check gap below: between this hunk's last line and next hunk's first line (or EOF)
								const nextHunk = idx < hunks.length - 1 ? hunks[idx + 1] : null;
								const nextFirst = nextHunk?.changes[0];
								const nextFirstLine = nextFirst?.type === "normal" ? nextFirst.oldLineNumber
									: nextFirst?.type === "delete" ? nextFirst.lineNumber : null;
								// Don't show expand-down if there's a fold decoration after this hunk
								const canExpandDown = !dh?.foldAfter && sessionId && (
									nextFirstLine ? lastLine < nextFirstLine - 1
									: fileLines ? lastLine < fileLines.length : lastLine > 0
								);

								// Show hunk header only if there's a gap above it that can be expanded
								const showHeader = canExpandUp;

								return [
									...(showHeader ? [
										<Decoration key={`decoration-${hunk.content}`}>
											<div
												onClick={() => canExpandUp && expandUp(origIdx)}
												className={`px-0 bg-[rgba(56,139,253,0.15)] text-[10px] font-mono flex items-center h-[14px] border-t border-b border-[rgba(56,139,253,0.1)] ${canExpandUp ? "cursor-pointer hover:bg-[rgba(56,139,253,0.25)]" : ""} transition-colors`}
											>
												{canExpandUp && (
													<span className="flex flex-col items-center justify-center w-[40px] shrink-0 h-full text-[#58a6ff] border-r border-[rgba(56,139,253,0.1)]">
														<svg className="w-2 h-2" viewBox="0 0 16 16" fill="currentColor"><path d="M12.78 6.22a.75.75 0 01-1.06 1.06L8 3.56 4.28 7.28a.75.75 0 01-1.06-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25z" /><path d="M12.78 11.22a.75.75 0 01-1.06 1.06L8 8.56l-3.72 3.72a.75.75 0 01-1.06-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25z" /></svg>
													</span>
												)}
												<span className="text-[rgba(139,186,255,0.7)] px-3 text-[9px] leading-none truncate">{hunk.content}</span>
											</div>
										</Decoration>,
									] : []),
									<Hunk key={hunk.content} hunk={hunk} />,
									...(dh?.foldAfter ? [
										<Decoration key={`fold-${dh.foldAfter.key}`}>
											<div
												onClick={() => toggleFold(dh.foldAfter!.key)}
												className="diff-fold-decoration"
											>
												<span className="diff-fold-decoration-icon">
													<svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5 L8 5 L3 8.5Z" /></svg>
												</span>
												<span className="diff-fold-decoration-label">{dh.foldAfter.label}</span>
												<span className="diff-fold-decoration-count">{dh.foldAfter.hiddenLineCount} lines</span>
												{dh.foldAfter.hiddenChangeCount > 0 && (
													<span className="diff-fold-decoration-badge">{dh.foldAfter.hiddenChangeCount} changes</span>
												)}
											</div>
										</Decoration>,
									] : []),
									...(canExpandDown ? [
										<Decoration key={`expand-down-${hunk.content}`}>
											<div
												onClick={() => expandDown(origIdx)}
												className="flex bg-[rgba(56,139,253,0.15)] h-[14px] border-t border-b border-[rgba(56,139,253,0.1)] cursor-pointer hover:bg-[rgba(56,139,253,0.25)] transition-colors"
											>
												<span className="flex items-center justify-center w-[40px] shrink-0 h-full text-[#58a6ff] border-r border-[rgba(56,139,253,0.1)]">
													<svg className="w-2 h-2" viewBox="0 0 16 16" fill="currentColor"><path d="M3.22 4.78a.75.75 0 011.06-1.06L8 7.44l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 4.78z" /><path d="M3.22 9.78a.75.75 0 011.06-1.06L8 12.44l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 9.78z" /></svg>
												</span>
											</div>
										</Decoration>,
									] : []),
								];
							})
						}
					</Diff>
				) : (
					<div className="px-4 py-3 text-xs text-zinc-600">Binary file or empty diff</div>
				)}
			</div>}
		</div>
	);
});

/** Only mount FileDiff when the placeholder scrolls into view. */
function LazyFileDiff(props: {
	file: FileData;
	viewType: ViewType;
	comments: ReviewComment[];
	githubComments?: GitHubReviewComment[];
	activeCommentLocation: { filePath: string; startLine: number; endLine: number } | null;
	onGutterClick: (filePath: string, startLine: number, endLine: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
	onReplyGitHubComment?: (threadId: string, content: string) => void;
	onResolveGitHubThread?: (threadId: string) => void;
	isViewed?: boolean;
	onToggleViewed?: () => void;
	sessionId?: string;
	onOpenInEditor?: (filePath: string) => void;
}) {
	const [visible, setVisible] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
			{ rootMargin: "800px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	if (!visible) {
		const filePath = props.file.newPath === "/dev/null" ? props.file.oldPath : props.file.newPath;
		const lineCount = props.file.hunks.reduce((n, h) => n + h.changes.length, 0);
		return (
			<div ref={ref} style={{ minHeight: Math.max(60, lineCount * 20) }} className="mb-4 mx-4">
				<div className="px-3 py-1.5 bg-[#161b22] border border-[#21262d] rounded-t-lg flex items-center gap-2">
					<span className={`text-[10px] font-bold shrink-0 ${
						props.file.type === "add" ? "text-emerald-400" : props.file.type === "delete" ? "text-red-400" : "text-amber-400"
					}`}>
						{props.file.type === "add" ? "NEW" : props.file.type === "delete" ? "DEL" : "MOD"}
					</span>
					<span className="text-xs text-zinc-500 font-mono truncate">{filePath}</span>
				</div>
				<div className="border border-t-0 border-[#21262d] rounded-b-lg px-3 py-2">
					<div className="flex items-center gap-2 text-zinc-700 text-xs">
						<span className="w-3.5 h-3.5 rounded-full border-2 border-zinc-800 border-t-zinc-600 animate-spin" />
						Loading diff…
					</div>
				</div>
			</div>
		);
	}

	return <FileDiff {...props} />;
}

export const DiffViewer = memo(function DiffViewer({
	rawDiff,
	viewType,
	comments,
	activeCommentLocation,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
	onResolveComment,
	onDeleteComment,
	selectedFile,
	isViewed,
	onToggleViewed,
	sessionId,
	onOpenInEditor,
	isLoading,
	onReplyComment,
	githubComments,
	onReplyGitHubComment,
	onResolveGitHubThread,
}: DiffViewerProps) {
	const files = useMemo(() => {
		if (!rawDiff) return [];
		try {
			return parseDiffDeduped(rawDiff);
		} catch (e) {
			console.error("Failed to parse diff:", e);
			return [];
		}
	}, [rawDiff]);

	if (files.length === 0) {
		if (isLoading) {
			return (
				<div className="flex-1 overflow-y-auto">
					{Array.from({ length: 5 }).map((_, i) => (
						<div key={i} className="mb-4 mx-4 first:mt-3 animate-pulse">
							<div className="px-3 py-1.5 bg-[#161b22] border border-[#21262d] rounded-t-lg flex items-center gap-2">
								<div className="w-7 h-3.5 rounded bg-zinc-800/80" />
								<div className="h-3.5 rounded bg-zinc-800/50 flex-1" style={{ maxWidth: `${30 + (i * 23) % 50}%` }} />
							</div>
							<div className="border border-t-0 border-[#21262d] rounded-b-lg p-3 space-y-2">
								{Array.from({ length: 3 + (i % 3) }).map((_, j) => (
									<div key={j} className="flex gap-2">
										<div className="w-8 h-3.5 rounded bg-zinc-800/30 shrink-0" />
										<div className="h-3.5 rounded bg-zinc-800/20 flex-1" style={{ maxWidth: `${40 + (j * 31) % 55}%` }} />
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			);
		}
		return (
			<div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
				No changes to review
			</div>
		);
	}

	// If a file is selected, only show that file (no lazy wrapper needed)
	if (selectedFile) {
		const file = files.find((f) => getFilePath(f) === selectedFile);
		if (!file) return null;
		return (
			<div className="flex-1 overflow-y-auto">
				<FileDiff
					key={getFilePath(file)}
					file={file}
					viewType={viewType}
					comments={comments}
					githubComments={githubComments}
					activeCommentLocation={activeCommentLocation}
					onGutterClick={onGutterClick}
					onSubmitComment={onSubmitComment}
					onCancelComment={onCancelComment}
					onResolveComment={onResolveComment}
					onDeleteComment={onDeleteComment}
					onReplyComment={onReplyComment}
					onReplyGitHubComment={onReplyGitHubComment}
					onResolveGitHubThread={onResolveGitHubThread}
					isViewed={isViewed?.(selectedFile) ?? false}
					onToggleViewed={onToggleViewed ? () => onToggleViewed(selectedFile!) : undefined}
					sessionId={sessionId}
					onOpenInEditor={onOpenInEditor}
				/>
			</div>
		);
	}

	// All files: lazy-render so only visible diffs mount
	return (
		<div className="flex-1 overflow-y-auto">
			{files.map((file) => {
				const fp = getFilePath(file);
				return (
				<LazyFileDiff
					key={fp}
					file={file}
					viewType={viewType}
					comments={comments}
					githubComments={githubComments}
					activeCommentLocation={activeCommentLocation}
					onGutterClick={onGutterClick}
					onSubmitComment={onSubmitComment}
					onCancelComment={onCancelComment}
					onResolveComment={onResolveComment}
					onDeleteComment={onDeleteComment}
					onReplyComment={onReplyComment}
					onReplyGitHubComment={onReplyGitHubComment}
					onResolveGitHubThread={onResolveGitHubThread}
					isViewed={isViewed?.(fp) ?? false}
					onToggleViewed={onToggleViewed ? () => onToggleViewed(fp) : undefined}
					sessionId={sessionId}
					onOpenInEditor={onOpenInEditor}
				/>
				);
			})}
		</div>
	);
});

/** Re-export for the page to build the file list. */
export { parseDiffDeduped as parseDiff, getFilePath };
