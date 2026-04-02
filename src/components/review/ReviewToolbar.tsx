"use client";

import { memo } from "react";

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
}

interface ReviewToolbarProps {
	sessionName: string;
	baseBranch: string;
	viewType: "split" | "unified";
	onToggleView: () => void;
	onRefreshDiff: () => void;
	isRefreshing: boolean;
	commits: CommitInfo[];
	selectedCommit: string;
	onSelectCommit: (hash: string) => void;
}

const btnClass =
	"h-8 px-3 text-xs rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors";

export const ReviewToolbar = memo(function ReviewToolbar({
	sessionName,
	baseBranch,
	viewType,
	onToggleView,
	onRefreshDiff,
	isRefreshing,
	commits,
	selectedCommit,
	onSelectCommit,
}: ReviewToolbarProps) {
	return (
		<div className="px-4 py-2.5 border-b border-zinc-800/50 bg-[#0a0a0f]/80 flex items-center gap-3 titlebar-no-drag relative z-[51]">
			<div className="flex items-center gap-2">
				<svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
					<path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
					<path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
				<span className="text-sm font-medium text-zinc-200">Review</span>
				<span className="text-xs text-zinc-500 truncate max-w-[200px]" title={sessionName}>
					{sessionName}
				</span>
			</div>

			<span className="text-[10px] text-zinc-600 px-2 py-0.5 rounded bg-zinc-800/50 border border-zinc-700/50">
				base: {baseBranch}
			</span>

			<select
				value={selectedCommit}
				onChange={(e) => onSelectCommit(e.target.value)}
				className="h-8 px-2 text-xs rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 transition-colors outline-none max-w-[300px] truncate"
			>
				<option value="all">All changes</option>
				<option value="uncommitted">Uncommitted changes</option>
				<option value="branch">All branch commits</option>
				<option value="committed">Unpushed commits</option>
				{commits.length > 0 && <option disabled>───────────</option>}
				{commits.map((c) => (
					<option key={c.hash} value={c.hash}>
						{c.shortHash} — {c.subject}
					</option>
				))}
			</select>

			<div className="flex-1" />

			<button onClick={onToggleView} className={btnClass}>
				{viewType === "split" ? "Unified" : "Split"}
			</button>

			<button onClick={onRefreshDiff} disabled={isRefreshing} className={`${btnClass} disabled:opacity-40`}>
				{isRefreshing ? (
					<span className="flex items-center gap-1.5">
						<span className="w-2.5 h-2.5 rounded-full border border-zinc-400 border-t-transparent animate-spin" />
						Refreshing
					</span>
				) : (
					"Refresh Diff"
				)}
			</button>
		</div>
	);
});
