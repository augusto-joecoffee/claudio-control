"use client";

import { memo, useCallback, useMemo, useState } from "react";
import type { ChangedBehavior, ChangedSymbol, ReviewComment } from "@/lib/types";
import { buildOrphanBehaviorId } from "@/lib/behavior/orphaned";
import { SideEffectBadge } from "./SideEffectBadge";
import { ConfidenceDots } from "./ConfidenceIndicator";

interface FlowListProps {
	behaviors: ChangedBehavior[];
	orphanedSymbols: ChangedSymbol[];
	selectedBehaviorId: string | null;
	onSelectBehavior: (id: string | null) => void;
	onCollapse?: () => void;
	isReviewed?: (id: string) => boolean;
	onToggleReviewed?: (behavior: ChangedBehavior) => void;
	reviewedCount?: number;
	comments: ReviewComment[];
	isLoading?: boolean;
}

function commentCountForBehavior(behavior: ChangedBehavior, comments: ReviewComment[]): number {
	const fileSet = new Set(behavior.touchedFiles);
	return comments.filter((c) => fileSet.has(c.filePath)).length;
}

function commentCountForOrphanedSymbol(symbol: ChangedSymbol, comments: ReviewComment[]): number {
	const startLine = symbol.location.line;
	const endLine = symbol.location.endLine ?? startLine;
	return comments.filter(
		(comment) =>
			comment.filePath === symbol.location.filePath &&
			comment.line >= startLine &&
			comment.line <= endLine,
	).length;
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

const FLOW_CATEGORY_ORDER: Array<ChangedBehavior["reviewCategory"]> = ["new", "modified", "impacted"];

const FLOW_CATEGORY_LABELS: Record<ChangedBehavior["reviewCategory"], string> = {
	new: "New Flows",
	modified: "Modified Flows",
	impacted: "Impacted Flows",
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
	const groupedBehaviors = useMemo(
		() =>
			FLOW_CATEGORY_ORDER.map((category) => ({
				category,
				label: FLOW_CATEGORY_LABELS[category],
				behaviors: behaviors.filter((behavior) => (behavior.reviewCategory ?? "modified") === category),
			})).filter((section) => section.behaviors.length > 0),
		[behaviors],
	);

	const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => {
		if (typeof window === "undefined") return new Set();
		try {
			const stored = localStorage.getItem("flow-list:collapsed-categories");
			return stored ? new Set(JSON.parse(stored)) : new Set();
		} catch {
			return new Set();
		}
	});

	const toggleCollapse = useCallback((category: string) => {
		setCollapsedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) next.delete(category);
			else next.add(category);
			localStorage.setItem("flow-list:collapsed-categories", JSON.stringify([...next]));
			return next;
		});
	}, []);

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
				{groupedBehaviors.map((section) => {
					const isCollapsed = collapsedCategories.has(section.category);
					return (
					<div key={section.category}>
						<button
							onClick={() => toggleCollapse(section.category)}
							className="w-full px-3 pt-3 pb-1 text-left"
						>
							<div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold hover:text-zinc-400 transition-colors">
								<div className="flex items-center gap-1">
									<svg className={`w-2.5 h-2.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
									</svg>
									<span>{section.label}</span>
								</div>
								<span>{section.behaviors.length}</span>
							</div>
						</button>
						{!isCollapsed && section.behaviors.map((behavior) => {
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
										{onToggleReviewed && (
											<button
												onClick={(e) => { e.stopPropagation(); onToggleReviewed(behavior); }}
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

										<button
											onClick={() => onSelectBehavior(isSelected ? null : behavior.id)}
											className={`flex-1 text-left ${onToggleReviewed ? "pl-0" : "pl-3"} pr-3 py-2 min-w-0`}
										>
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
					</div>
					);
				})}

				{/* Changed symbols that could not be attached to a flow */}
				{orphanedSymbols.length > 0 && (
					<>
						<button
							onClick={() => toggleCollapse("orphaned")}
							className="w-full px-3 pt-3 pb-1 text-left"
						>
							<div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold hover:text-zinc-400 transition-colors">
								<div className="flex items-center gap-1">
									<svg className={`w-2.5 h-2.5 transition-transform ${collapsedCategories.has("orphaned") ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
									</svg>
									<span>Changes Without Flow</span>
								</div>
								<span>{orphanedSymbols.length}</span>
							</div>
						</button>
						{!collapsedCategories.has("orphaned") && orphanedSymbols.map((sym, i) => {
							const orphanId = buildOrphanBehaviorId(sym);
							const fileName = sym.location.filePath.split("/").pop() ?? "";
							const isSelected = selectedBehaviorId === orphanId;
							const commentCount = commentCountForOrphanedSymbol(sym, comments);
							return (
								<div
									key={orphanId}
									className={`w-full hover:bg-white/5 transition-colors cursor-pointer ${
										isSelected ? "bg-white/8 border-l-2 border-violet-500" : "border-l-2 border-transparent"
									}`}
								>
									<button
										onClick={() => onSelectBehavior(isSelected ? null : orphanId)}
										className="w-full text-left px-3 py-2"
									>
										<div className="flex items-center gap-1.5 mb-0.5">
											<span className="text-[9px] font-mono font-bold text-zinc-500 shrink-0">NF</span>
											<span className="text-xs text-zinc-300 truncate flex-1" title={sym.qualifiedName ?? sym.name}>
												{sym.qualifiedName ?? sym.name}
											</span>
											<span className="text-[10px] text-zinc-600 shrink-0">1 file</span>
										</div>
										<div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
											<span>{fileName}:{sym.location.line}</span>
											{commentCount > 0 && (
												<span className="ml-auto bg-violet-500/20 text-violet-300 rounded-full px-1.5 text-[10px]">
													{commentCount}
												</span>
											)}
										</div>
									</button>
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
