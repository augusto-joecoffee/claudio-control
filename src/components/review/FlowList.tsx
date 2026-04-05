"use client";

import { memo, useMemo } from "react";
import type { ChangedBehavior, ChangedSymbol, ReviewComment } from "@/lib/types";
import { SideEffectBadge } from "./SideEffectBadge";
import { ConfidenceDots } from "./ConfidenceIndicator";

interface FlowListProps {
	behaviors: ChangedBehavior[];
	orphanedSymbols: ChangedSymbol[];
	selectedBehaviorId: string | null;
	onSelectBehavior: (id: string | null) => void;
	onCollapse?: () => void;
	isReviewed?: (id: string) => boolean;
	onToggleReviewed?: (id: string) => void;
	reviewedCount?: number;
	comments: ReviewComment[];
	isLoading?: boolean;
}

function commentCountForBehavior(behavior: ChangedBehavior, comments: ReviewComment[]): number {
	const fileSet = new Set(behavior.touchedFiles);
	return comments.filter((c) => fileSet.has(c.filePath)).length;
}

const ENTRYPOINT_ICONS: Record<string, string> = {
	"api-route": "API",
	"event-handler": "EVT",
	"queue-consumer": "Q",
	"cli-command": "CLI",
	"test-function": "TST",
	"exported-function": "FN",
	"cron-job": "CRN",
	"react-component": "JSX",
	"unknown": "?",
};

const ENTRYPOINT_COLORS: Record<string, string> = {
	"api-route": "text-blue-400",
	"event-handler": "text-emerald-400",
	"queue-consumer": "text-violet-400",
	"cli-command": "text-amber-400",
	"test-function": "text-cyan-400",
	"exported-function": "text-zinc-400",
	"cron-job": "text-amber-400",
	"react-component": "text-blue-400",
	"unknown": "text-zinc-500",
};

export const FlowList = memo(function FlowList({
	behaviors,
	orphanedSymbols,
	selectedBehaviorId,
	onSelectBehavior,
	onCollapse,
	isReviewed,
	onToggleReviewed,
	reviewedCount,
	comments,
	isLoading,
}: FlowListProps) {
	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="px-3 py-2 border-b border-zinc-800/50 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
						Flows {isLoading ? "" : `(${behaviors.length})`}
					</h2>
					{reviewedCount != null && behaviors.length > 0 && (
						<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
							reviewedCount === behaviors.length
								? "bg-emerald-500/15 text-emerald-400"
								: "bg-zinc-700/50 text-zinc-500"
						}`}>
							{reviewedCount}/{behaviors.length}
						</span>
					)}
				</div>
				{onCollapse && (
					<button onClick={onCollapse} className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5" title="Hide flows">
						<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
						</svg>
					</button>
				)}
			</div>

			{/* Flow list */}
			<div className="flex-1 overflow-y-auto py-1">
				{/* Loading skeleton */}
				{isLoading && behaviors.length === 0 && (
					Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="px-3 py-2 border-l-2 border-transparent animate-pulse">
							<div className="flex items-center gap-2 mb-1">
								<div className="w-6 h-4 rounded bg-zinc-800/60 shrink-0" />
								<div className="h-3.5 rounded bg-zinc-800/50 flex-1" style={{ maxWidth: `${50 + (i * 23) % 40}%` }} />
							</div>
							<div className="flex items-center gap-2">
								<div className="w-10 h-3 rounded bg-zinc-800/40 shrink-0" />
								<div className="w-8 h-3 rounded bg-zinc-800/30 shrink-0" />
							</div>
						</div>
					))
				)}

				{/* Behavior rows */}
				{behaviors.map((behavior) => {
					const isSelected = selectedBehaviorId === behavior.id;
					const reviewed = isReviewed?.(behavior.id) ?? false;
					const commentCount = commentCountForBehavior(behavior, comments);
					const icon = ENTRYPOINT_ICONS[behavior.entrypointKind] ?? "?";
					const iconColor = ENTRYPOINT_COLORS[behavior.entrypointKind] ?? "text-zinc-500";

					return (
						<div
							key={behavior.id}
							className={`w-full hover:bg-white/5 transition-colors cursor-pointer ${
								isSelected ? "bg-white/8 border-l-2 border-violet-500" : "border-l-2 border-transparent"
							} ${reviewed ? "opacity-50" : ""}`}
						>
							<div className="flex items-start gap-1">
								{/* Review checkbox */}
								{onToggleReviewed && (
									<button
										onClick={(e) => { e.stopPropagation(); onToggleReviewed(behavior.id); }}
										className="pl-2 pt-2 text-zinc-600 hover:text-emerald-400 transition-colors shrink-0"
										title={reviewed ? "Mark as unreviewed" : "Mark as reviewed"}
									>
										<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
											{reviewed ? (
												<path d="M4.5 12.75l6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400" />
											) : (
												<rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
											)}
										</svg>
									</button>
								)}

								{/* Main click area */}
								<button
									onClick={() => onSelectBehavior(isSelected ? null : behavior.id)}
									className={`flex-1 text-left ${onToggleReviewed ? "pl-0" : "pl-3"} pr-3 py-2 min-w-0`}
								>
									{/* Row 1: icon + name + file count */}
									<div className="flex items-center gap-1.5 mb-0.5">
										<span className={`text-[9px] font-mono font-bold shrink-0 ${iconColor}`}>
											{icon}
										</span>
										<span className="text-xs text-zinc-300 truncate flex-1" title={behavior.name}>
											{behavior.name}
										</span>
										<span className="text-[10px] text-zinc-600 shrink-0">
											{behavior.touchedFiles.length} file{behavior.touchedFiles.length !== 1 ? "s" : ""}
										</span>
									</div>

									{/* Row 2: confidence + side effects + comment count */}
									<div className="flex items-center gap-1.5">
										<ConfidenceDots level={behavior.confidence} />
										{behavior.sideEffects.slice(0, 3).map((se, i) => (
											<SideEffectBadge key={i} kind={se.kind} compact />
										))}
										{behavior.sideEffects.length > 3 && (
											<span className="text-[9px] text-zinc-600">+{behavior.sideEffects.length - 3}</span>
										)}
										{commentCount > 0 && (
											<span className="ml-auto bg-violet-500/20 text-violet-300 rounded-full px-1.5 text-[10px]">
												{commentCount}
											</span>
										)}
									</div>
								</button>
							</div>
						</div>
					);
				})}

				{/* Orphaned / untraced changes */}
				{orphanedSymbols.length > 0 && (
					<>
						<div className="px-3 pt-3 pb-1">
							<div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">
								Untraced Changes
							</div>
						</div>
						{orphanedSymbols.map((sym, i) => {
							const fileName = sym.location.filePath.split("/").pop() ?? "";
							return (
								<div key={i} className="px-3 py-1.5 text-xs text-zinc-500 border-l-2 border-transparent">
									<span className="text-zinc-400">{sym.name}</span>
									<span className="text-zinc-600 ml-1.5">{fileName}:{sym.location.line}</span>
								</div>
							);
						})}
					</>
				)}

				{/* Empty state */}
				{!isLoading && behaviors.length === 0 && orphanedSymbols.length === 0 && (
					<div className="px-3 py-6 text-center">
						<div className="text-xs text-zinc-600 mb-1">No flows detected</div>
						<div className="text-[10px] text-zinc-700">
							The analysis found no TS/JS entrypoints in this diff.
						</div>
					</div>
				)}
			</div>
		</div>
	);
});
