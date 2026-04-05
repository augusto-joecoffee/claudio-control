"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ExecutionStep, ReviewComment } from "@/lib/types";
import { CodeSnippetView } from "./CodeSnippet";
import { SideEffectBadge } from "./SideEffectBadge";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { CommentThread } from "./CommentThread";

interface FlowStepCardProps {
	step: ExecutionStep;
	totalSteps: number;
	isReviewed?: boolean;
	onToggleReviewed?: (step: ExecutionStep) => void;
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
	isReviewed = false,
	onToggleReviewed,
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
	const lineRange = step.snippet.endLine > step.snippet.startLine
		? `${step.snippet.startLine}-${step.snippet.endLine}`
		: `${step.snippet.startLine}`;

	const stepComments = useMemo(
		() =>
			comments.filter(
				(comment) =>
					comment.filePath === step.symbol.location.filePath &&
					comment.line >= step.snippet.startLine &&
					comment.line <= step.snippet.endLine,
			),
		[comments, step],
	);

	const isActiveComment = activeCommentLine !== null &&
		activeCommentLine >= step.snippet.startLine &&
		activeCommentLine <= step.snippet.endLine;

	const [expanded, setExpanded] = useState(step.isChanged && !isReviewed);

	useEffect(() => {
		if (isActiveComment || stepComments.length > 0) {
			setExpanded(true);
			return;
		}
		setExpanded(step.isChanged && !isReviewed);
	}, [isReviewed, isActiveComment, step.id, step.isChanged, stepComments.length]);

	const handleLineClick = useCallback(
		(line: number) => {
			const lines = (step.snippet.content ?? "").split("\n");
			const relIdx = line - step.snippet.startLine;
			const start = Math.max(0, relIdx - 1);
			const end = Math.min(lines.length, relIdx + 2);
			const anchorSnippet = lines.slice(start, end).join("\n");
			onGutterClick(step.symbol.location.filePath, line, anchorSnippet);
		},
		[step, onGutterClick],
	);

	return (
		<div className={`rounded-lg border overflow-hidden ${
			step.confidence === "low"
				? "border-zinc-800/30 opacity-60"
				: step.isChanged
					? "border-zinc-700/50"
					: "border-zinc-800/30"
		}`}>
			<div className="px-3 py-2 bg-zinc-900/50 border-b border-zinc-800/50 flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-[10px] text-zinc-600 shrink-0">
						{step.order + 1}/{totalSteps}
					</span>
					<span className="text-xs text-zinc-300 font-medium truncate">
						{step.symbol.qualifiedName ?? step.symbol.name}
					</span>
					{step.isChanged ? (
						<span className={`text-[9px] px-1 py-0 rounded border shrink-0 ${
							isReviewed
								? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
								: "bg-amber-500/10 text-amber-300 border-amber-500/30"
						}`}>
							{isReviewed ? "VIEWED" : "CHANGED"}
						</span>
					) : (
						<span className="text-[9px] px-1 py-0 rounded border border-zinc-700/70 text-zinc-500 shrink-0">
							CONTEXT
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					{step.isChanged && onToggleReviewed && (
						<button
							onClick={() => onToggleReviewed(step)}
							className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors ${
								isReviewed
									? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
									: "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
							}`}
						>
							<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
								{isReviewed ? (
									<path d="M4.5 12.75l6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round" fill="none" className="text-emerald-400" />
								) : (
									<rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
								)}
							</svg>
							Viewed
						</button>
					)}
					{step.sideEffects.map((effect, i) => (
						<SideEffectBadge key={i} kind={effect.kind} description={effect.description} compact />
					))}
					<ConfidenceIndicator level={step.confidence} />
				</div>
			</div>

			<div className="px-3 py-1 bg-zinc-900/30 border-b border-zinc-800/30 flex items-center justify-between gap-2">
				<span className="text-[10px] text-zinc-500 font-mono truncate">
					{step.symbol.location.filePath}:{lineRange}
				</span>
				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={() => setExpanded((value) => !value)}
						className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
					>
						{expanded ? "Collapse" : "Expand"}
					</button>
					<span className="text-[10px] text-zinc-600 italic">
						{step.rationale}
					</span>
				</div>
			</div>

			{expanded && step.snippet.content ? (
				<CodeSnippetView
					snippet={step.snippet}
					changedLines={changedLines}
					collapseUnchangedGaps={step.isChanged}
					onLineClick={handleLineClick}
				/>
			) : (
				<div className="px-3 py-2 bg-zinc-950/50 text-[11px] text-zinc-600 border-b border-zinc-800/30">
					{step.isChanged
						? isReviewed
							? "Viewed function collapsed. Expand if you need to revisit it in this flow."
							: "Changed function collapsed. Expand to review the modified code."
						: "Unchanged context collapsed. Expand to inspect the full function."}
				</div>
			)}

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

			<div className="px-3 py-1.5 bg-zinc-900/20 border-t border-zinc-800/30 flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					{step.sideEffects.length > 0 && (
						<span className="text-[10px] text-zinc-500 truncate">
							{step.sideEffects.map((effect) => effect.description).join(", ")}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 shrink-0">
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

			{step.callsTo.length > 0 && (
				<div className="px-3 py-1 border-t border-zinc-800/20 text-[10px] text-zinc-600">
					&darr; calls {step.callsTo.join(", ")}
				</div>
			)}
		</div>
	);
});
