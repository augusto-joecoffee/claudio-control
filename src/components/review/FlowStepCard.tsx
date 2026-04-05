"use client";

import { memo, useCallback, useMemo, useState } from "react";
import type { ExecutionStep, ReviewComment } from "@/lib/types";
import { CodeSnippetView } from "./CodeSnippet";
import { SideEffectBadge } from "./SideEffectBadge";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { CommentThread } from "./CommentThread";

interface FlowStepCardProps {
	step: ExecutionStep;
	totalSteps: number;
	changedLines?: Set<number>;
	comments: ReviewComment[];
	activeCommentLine: number | null;
	onGutterClick: (filePath: string, line: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
	onViewInDiff: (filePath: string, line: number) => void;
	onOpenInEditor?: (filePath: string) => void;
}

export const FlowStepCard = memo(function FlowStepCard({
	step,
	totalSteps,
	changedLines,
	comments,
	activeCommentLine,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
	onResolveComment,
	onDeleteComment,
	onReplyComment,
	onViewInDiff,
	onOpenInEditor,
}: FlowStepCardProps) {
	const fileName = step.symbol.location.filePath.split("/").pop() ?? "";
	const lineRange = step.snippet.endLine > step.snippet.startLine
		? `${step.snippet.startLine}-${step.snippet.endLine}`
		: `${step.snippet.startLine}`;

	// Filter comments that fall within this step's snippet range
	const stepComments = useMemo(
		() =>
			comments.filter(
				(c) =>
					c.filePath === step.symbol.location.filePath &&
					c.line >= step.snippet.startLine &&
					c.line <= step.snippet.endLine,
			),
		[comments, step],
	);

	const handleLineClick = useCallback(
		(line: number) => {
			// Build anchor snippet from the step's code
			const lines = (step.snippet.content ?? "").split("\n");
			const relIdx = line - step.snippet.startLine;
			const start = Math.max(0, relIdx - 1);
			const end = Math.min(lines.length, relIdx + 2);
			const anchorSnippet = lines.slice(start, end).join("\n");
			onGutterClick(step.symbol.location.filePath, line, anchorSnippet);
		},
		[step, onGutterClick],
	);

	const isActiveComment = activeCommentLine !== null &&
		activeCommentLine >= step.snippet.startLine &&
		activeCommentLine <= step.snippet.endLine;

	return (
		<div className={`rounded-lg border overflow-hidden ${
			step.confidence === "low"
				? "border-zinc-800/30 opacity-60"
				: step.isChanged
					? "border-zinc-700/50"
					: "border-zinc-800/30"
		}`}>
			{/* Step header */}
			<div className="px-3 py-2 bg-zinc-900/50 border-b border-zinc-800/50 flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-[10px] text-zinc-600 shrink-0">
						{step.order + 1}/{totalSteps}
					</span>
					<span className="text-xs text-zinc-300 font-medium truncate">
						{step.symbol.qualifiedName ?? step.symbol.name}
					</span>
					{step.isChanged && (
						<span className="text-[9px] px-1 py-0 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
							CHANGED
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					{step.sideEffects.map((se, i) => (
						<SideEffectBadge key={i} kind={se.kind} description={se.description} compact />
					))}
					<ConfidenceIndicator level={step.confidence} />
				</div>
			</div>

			{/* File path + line range */}
			<div className="px-3 py-1 bg-zinc-900/30 border-b border-zinc-800/30 flex items-center justify-between">
				<span className="text-[10px] text-zinc-500 font-mono truncate">
					{step.symbol.location.filePath}:{lineRange}
				</span>
				<span className="text-[10px] text-zinc-600 italic">
					{step.rationale}
				</span>
			</div>

			{/* Code snippet */}
			{step.snippet.content && (
				<CodeSnippetView
					snippet={step.snippet}
					changedLines={changedLines}
					onLineClick={handleLineClick}
				/>
			)}

			{/* Inline comments + active comment input */}
			{(stepComments.length > 0 || isActiveComment) && (
				<div className="border-t border-zinc-800/50">
					<CommentThread
						comments={stepComments}
						isAddingComment={isActiveComment}
						onSubmitComment={onSubmitComment}
						onCancelComment={onCancelComment}
						onResolveComment={onResolveComment}
						onDeleteComment={onDeleteComment}
						onReplyComment={onReplyComment}
					/>
				</div>
			)}

			{/* Step footer: side effects detail + actions */}
			<div className="px-3 py-1.5 bg-zinc-900/20 border-t border-zinc-800/30 flex items-center justify-between">
				<div className="flex items-center gap-2">
					{step.sideEffects.length > 0 && (
						<span className="text-[10px] text-zinc-500">
							{step.sideEffects.map((se) => se.description).join(", ")}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => onViewInDiff(step.symbol.location.filePath, step.symbol.location.line)}
						className="text-[10px] text-zinc-500 hover:text-blue-400 transition-colors"
					>
						View in Diff &rarr;
					</button>
					{onOpenInEditor && (
						<button
							onClick={() => onOpenInEditor(step.symbol.location.filePath)}
							className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							Open in Editor
						</button>
					)}
				</div>
			</div>

			{/* Callees indicator */}
			{step.callsTo.length > 0 && (
				<div className="px-3 py-1 border-t border-zinc-800/20 text-[10px] text-zinc-600">
					&darr; calls {step.callsTo.join(", ")}
				</div>
			)}
		</div>
	);
});
