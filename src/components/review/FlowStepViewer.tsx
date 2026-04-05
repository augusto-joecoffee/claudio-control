"use client";

import { memo, useMemo, useState } from "react";
import type { ChangedBehavior, ReviewComment } from "@/lib/types";
import { FlowStepCard } from "./FlowStepCard";
import { SideEffectBadge } from "./SideEffectBadge";
import { ConfidenceIndicator } from "./ConfidenceIndicator";

interface FlowStepViewerProps {
	behavior: ChangedBehavior;
	comments: ReviewComment[];
	isFlowReviewed?: boolean;
	onToggleFlowReviewed?: (behavior: ChangedBehavior) => void;
	isStepReviewed?: (stepId: string) => boolean;
	onToggleStepReviewed?: (step: ChangedBehavior["steps"][number]) => void;
	activeCommentLocation: { filePath: string; startLine: number; endLine: number } | null;
	onGutterClick: (filePath: string, startLine: number, endLine: number, anchorSnippet: string) => void;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
	onViewInDiff: (filePath: string, line: number) => void;
	onOpenInEditor?: (filePath: string) => void;
	warnings?: string[];
}

/** Build a set of line numbers that are in changed diff hunks for highlighting. */
function buildChangedLineSet(behavior: ChangedBehavior): Map<string, Set<number>> {
	const map = new Map<string, Set<number>>();
	for (const step of behavior.steps) {
		if (!step.isChanged) continue;
		const file = step.symbol.location.filePath;
		const existing = map.get(file) ?? new Set<number>();

		if (step.changedRanges && step.changedRanges.length > 0) {
			// Use the exact diff-changed line ranges
			for (const range of step.changedRanges) {
				for (let i = range.start; i <= range.end; i++) existing.add(i);
			}
		} else {
			// Fallback: highlight the full symbol range
			const start = step.symbol.location.line;
			const end = step.symbol.location.endLine ?? start;
			for (let i = start; i <= end; i++) existing.add(i);
		}

		map.set(file, existing);
	}
	return map;
}

export const FlowStepViewer = memo(function FlowStepViewer({
	behavior,
	comments,
	isFlowReviewed,
	onToggleFlowReviewed,
	isStepReviewed,
	onToggleStepReviewed,
	activeCommentLocation,
	onGutterClick,
	onSubmitComment,
	onCancelComment,
	onResolveComment,
	onDeleteComment,
	onReplyComment,
	onViewInDiff,
	onOpenInEditor,
	warnings,
}: FlowStepViewerProps) {
	const [showWarnings, setShowWarnings] = useState(false);
	const changedLinesByFile = useMemo(() => buildChangedLineSet(behavior), [behavior]);

	const entrypointKindLabel: Record<string, string> = {
		"api-route": "API Route",
		"event-handler": "Event Handler",
		"queue-consumer": "Queue Consumer",
		"cli-command": "CLI Command",
		"test-function": "Test",
		"exported-function": "Exported Function",
		"cron-job": "Cron Job",
		"react-component": "React Component",
		"unknown": "Unknown",
	};

	return (
		<div className="flex-1 overflow-y-auto px-4 py-4">
			{/* Flow header */}
			<div className="mb-4 pb-3 border-b border-zinc-800/50">
				<div className="flex items-center gap-2 mb-1.5">
					<h2 className="text-sm font-medium text-zinc-200">{behavior.name}</h2>
					<ConfidenceIndicator level={behavior.confidence} showLabel />
					{onToggleFlowReviewed && (
						<button
							onClick={() => onToggleFlowReviewed(behavior)}
							className={`ml-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${
								isFlowReviewed
									? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
									: "border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40"
							}`}
						>
							{isFlowReviewed ? "Flow Viewed" : "Mark Flow Viewed"}
						</button>
					)}
				</div>
				<div className="flex items-center gap-3 text-[11px] text-zinc-500">
					<span>{entrypointKindLabel[behavior.entrypointKind] ?? behavior.entrypointKind}</span>
					<span>&middot;</span>
					<span>{behavior.totalStepCount} step{behavior.totalStepCount !== 1 ? "s" : ""}</span>
					<span>&middot;</span>
					<span>{behavior.changedStepCount} changed</span>
					<span>&middot;</span>
					<span>{behavior.touchedFiles.length} file{behavior.touchedFiles.length !== 1 ? "s" : ""}</span>
				</div>
				{behavior.sideEffects.length > 0 && (
					<div className="flex items-center gap-1.5 mt-2">
						<span className="text-[10px] text-zinc-600">Side effects:</span>
						{behavior.sideEffects.map((se, i) => (
							<SideEffectBadge key={i} kind={se.kind} description={se.description} />
						))}
					</div>
				)}
				{/* Files list */}
				<div className="mt-2 text-[10px] text-zinc-600">
					{behavior.touchedFiles.map((f) => f.split("/").pop()).join(", ")}
				</div>
			</div>

			{/* Analysis warnings */}
			{warnings && warnings.length > 0 && (
				<div className="mb-3">
					<button
						onClick={() => setShowWarnings((v) => !v)}
						className="text-[10px] text-amber-500/60 hover:text-amber-400 transition-colors flex items-center gap-1"
					>
						<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
						</svg>
						{warnings.length} analysis note{warnings.length !== 1 ? "s" : ""}
						<svg className={`w-2.5 h-2.5 transition-transform ${showWarnings ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
						</svg>
					</button>
					{showWarnings && (
						<div className="mt-1.5 space-y-0.5">
							{warnings.map((w, i) => (
								<div key={i} className="text-[10px] text-amber-500/40 pl-4">
									{w}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Step timeline */}
			<div className="space-y-0">
				{behavior.steps.map((step, i) => (
					<div key={step.id}>
						<FlowStepCard
							step={step}
							totalSteps={behavior.totalStepCount}
							isReviewed={isStepReviewed?.(step.id) ?? false}
							onToggleReviewed={onToggleStepReviewed}
							changedLines={changedLinesByFile.get(step.symbol.location.filePath)}
							comments={comments}
							activeCommentLine={
								activeCommentLocation?.filePath === step.symbol.location.filePath
									? activeCommentLocation.startLine
									: null
							}
							onGutterClick={(filePath, line, anchorSnippet) =>
								onGutterClick(filePath, line, line, anchorSnippet)
							}
							onSubmitComment={onSubmitComment}
							onCancelComment={onCancelComment}
							onResolveComment={onResolveComment}
							onDeleteComment={onDeleteComment}
							onReplyComment={onReplyComment}
							onViewInDiff={onViewInDiff}
							onOpenInEditor={onOpenInEditor}
						/>
						{/* Connector line between steps */}
						{i < behavior.steps.length - 1 && (
							<div className="flex justify-center py-1">
								<div className="w-px h-6 border-l border-dashed border-zinc-700" />
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
});
