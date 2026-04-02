"use client";

interface ReviewToolbarProps {
	sessionName: string;
	baseBranch: string;
	viewType: "split" | "unified";
	onToggleView: () => void;
	onRefreshDiff: () => void;
	isRefreshing: boolean;
}

export function ReviewToolbar({
	sessionName,
	baseBranch,
	viewType,
	onToggleView,
	onRefreshDiff,
	isRefreshing,
}: ReviewToolbarProps) {
	return (
		<div className="px-4 py-2 border-b border-zinc-800/50 bg-[#0a0a0f]/80 flex items-center gap-3">
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

			<div className="flex-1" />

			<button
				onClick={onToggleView}
				className="px-2 py-1 text-[11px] rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
			>
				{viewType === "split" ? "Unified" : "Split"}
			</button>

			<button
				onClick={onRefreshDiff}
				disabled={isRefreshing}
				className="px-2 py-1 text-[11px] rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40"
			>
				{isRefreshing ? (
					<span className="flex items-center gap-1">
						<span className="w-2.5 h-2.5 rounded-full border border-zinc-400 border-t-transparent animate-spin" />
						Refreshing
					</span>
				) : (
					"Refresh Diff"
				)}
			</button>
		</div>
	);
}
