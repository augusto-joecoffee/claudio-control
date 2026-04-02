"use client";

import { memo, useCallback, useMemo, useRef } from "react";
import { Diff, Hunk, Decoration, parseDiff, getChangeKey } from "react-diff-view";
import type { FileData, ChangeData, HunkData } from "react-diff-view";
import type { GutterOptions, ViewType } from "react-diff-view";
import type { ReviewComment } from "@/lib/types";
import { CommentThread } from "./CommentThread";
import "react-diff-view/style/index.css";

interface DiffViewerProps {
	rawDiff: string;
	viewType: ViewType;
	comments: ReviewComment[];
	activeCommentLocation: { filePath: string; line: number } | null;
	onGutterClick: (filePath: string, line: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	selectedFile: string | null;
}

function getFilePath(file: FileData): string {
	return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
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

const FileDiff = memo(function FileDiff({
	file,
	viewType,
	comments,
	activeCommentLocation,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
}: {
	file: FileData;
	viewType: ViewType;
	comments: ReviewComment[];
	activeCommentLocation: { filePath: string; line: number } | null;
	onGutterClick: (filePath: string, line: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
}) {
	const filePath = getFilePath(file);
	const fileComments = useMemo(() => comments.filter((c) => c.filePath === filePath), [comments, filePath]);
	const fileRef = useRef<HTMLDivElement>(null);

	// Build widgets map: changeKey → ReactNode for inline comments
	const widgets = useMemo(() => {
		const w: Record<string, React.ReactNode> = {};

		// Group comments by line
		const commentsByLine = new Map<number, ReviewComment[]>();
		for (const c of fileComments) {
			const existing = commentsByLine.get(c.line) ?? [];
			existing.push(c);
			commentsByLine.set(c.line, existing);
		}

		// For each line with comments, find the corresponding change and add a widget
		for (const [line, lineComments] of commentsByLine) {
			const result = findChangeIndexByNewLine(file.hunks, line);
			if (result) {
				const key = getChangeKey(result.hunk.changes[result.index]);
				const isAdding = activeCommentLocation?.filePath === filePath && activeCommentLocation?.line === line;
				w[key] = (
					<CommentThread
						comments={lineComments}
						isAddingComment={isAdding}
						onSubmitComment={onSubmitComment}
						onCancelComment={onCancelComment}
					/>
				);
			}
		}

		// Handle the case where we're adding a new comment on a line that has no comments yet
		if (activeCommentLocation?.filePath === filePath) {
			const hasExistingWidget = fileComments.some((c) => c.line === activeCommentLocation.line);
			if (!hasExistingWidget) {
				const result = findChangeIndexByNewLine(file.hunks, activeCommentLocation.line);
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
	}, [fileComments, activeCommentLocation, filePath, file.hunks, onSubmitComment, onCancelComment]);

	const handleGutterClick = useCallback(
		({ change }: { change: ChangeData | null }) => {
			if (!change) return;
			const newLine =
				change.type === "normal" ? change.newLineNumber : change.type === "insert" ? change.lineNumber : null;
			if (newLine === null) return;

			const result = findChangeIndexByNewLine(file.hunks, newLine);
			const snippet = result ? getAnchorSnippet(result.hunk, result.index) : "";
			onGutterClick(filePath, newLine, snippet);
		},
		[file.hunks, filePath, onGutterClick],
	);

	const renderGutter = useCallback(
		({ change, side, renderDefault }: GutterOptions) => {
			if (side === "new" || (viewType === "unified" && change.type !== "delete")) {
				return (
					<span className="cursor-pointer hover:bg-violet-500/20 rounded px-0.5" title="Add comment">
						{renderDefault()}
					</span>
				);
			}
			return renderDefault();
		},
		[viewType],
	);

	const gutterEvents = useMemo(() => ({ onClick: handleGutterClick }), [handleGutterClick]);

	return (
		<div ref={fileRef} id={`file-${filePath}`} className="mb-4">
			{/* File header */}
			<div className="sticky top-0 z-10 px-3 py-1.5 bg-zinc-900/95 border border-zinc-800/50 rounded-t-lg flex items-center gap-2 backdrop-blur-sm">
				<span
					className={`text-[10px] font-bold ${
						file.type === "add" ? "text-emerald-400" : file.type === "delete" ? "text-red-400" : "text-amber-400"
					}`}
				>
					{file.type === "add" ? "NEW" : file.type === "delete" ? "DEL" : "MOD"}
				</span>
				<span className="text-xs text-zinc-300 font-mono">{filePath}</span>
			</div>

			{/* Diff content */}
			<div className="border border-t-0 border-zinc-800/50 rounded-b-lg overflow-hidden diff-viewer-container">
				{file.hunks.length > 0 ? (
					<Diff
						viewType={viewType}
						diffType={file.type}
						hunks={file.hunks}
						widgets={widgets}
						renderGutter={renderGutter}
						gutterEvents={gutterEvents}
					>
						{(hunks: HunkData[]) =>
							hunks.flatMap((hunk) => [
								<Decoration key={`decoration-${hunk.content}`}>
									<div className="px-3 py-1 bg-blue-500/5 text-[10px] text-blue-400 font-mono border-y border-blue-500/10">
										{hunk.content}
									</div>
								</Decoration>,
								<Hunk key={hunk.content} hunk={hunk} />,
							])
						}
					</Diff>
				) : (
					<div className="px-4 py-3 text-xs text-zinc-600">Binary file or empty diff</div>
				)}
			</div>
		</div>
	);
});

export const DiffViewer = memo(function DiffViewer({
	rawDiff,
	viewType,
	comments,
	activeCommentLocation,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
	selectedFile,
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
		return (
			<div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
				No changes to review
			</div>
		);
	}

	// If a file is selected, only show that file
	const filesToRender = selectedFile
		? files.filter((f) => getFilePath(f) === selectedFile)
		: files;

	return (
		<div className="flex-1 overflow-y-auto px-4 py-3">
			{filesToRender.map((file) => (
				<FileDiff
					key={getFilePath(file)}
					file={file}
					viewType={viewType}
					comments={comments}
					activeCommentLocation={activeCommentLocation}
					onGutterClick={onGutterClick}
					onSubmitComment={onSubmitComment}
					onCancelComment={onCancelComment}
				/>
			))}
		</div>
	);
});

/** Re-export for the page to build the file list. */
export { parseDiffDeduped as parseDiff, getFilePath };
