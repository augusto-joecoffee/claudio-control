"use client";

interface CommentQueueProps {
	pendingCount: number;
	processingId: string | null;
	completedCount: number;
	sessionStatus: string;
	paused: boolean;
	onTogglePause: () => void;
}

export function CommentQueue({
	pendingCount,
	processingId,
	completedCount,
	sessionStatus,
	paused,
	onTogglePause,
}: CommentQueueProps) {
	const total = pendingCount + completedCount + (processingId ? 1 : 0);

	if (total === 0) {
		return (
			<div className="px-4 py-2 border-t border-zinc-800/50 bg-[#0a0a0f]/80 text-xs text-zinc-600">
				Click on a line number in the diff to add a review comment
			</div>
		);
	}

	return (
		<div className="px-4 py-2 border-t border-zinc-800/50 bg-[#0a0a0f]/80 flex items-center gap-4 text-xs">
			<div className="flex items-center gap-3">
				{pendingCount > 0 && (
					<span className="text-zinc-400">
						<span className="text-zinc-200 font-medium">{pendingCount}</span> pending
					</span>
				)}
				{processingId && (
					<span className="text-blue-400 flex items-center gap-1.5">
						<span className="w-2 h-2 rounded-full border border-blue-400 border-t-transparent animate-spin" />
						Processing
					</span>
				)}
				{completedCount > 0 && (
					<span className="text-emerald-400">
						<span className="text-emerald-300 font-medium">{completedCount}</span> resolved
					</span>
				)}
			</div>

			<div className="flex-1" />

			{sessionStatus !== "idle" && sessionStatus !== "waiting" && sessionStatus !== "finished" && (
				<span className="text-amber-400 text-[10px]">Session {sessionStatus}...</span>
			)}

			{/* Progress bar */}
			{total > 0 && (
				<div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
					<div
						className="h-full bg-emerald-500 transition-all duration-300"
						style={{ width: `${(completedCount / total) * 100}%` }}
					/>
				</div>
			)}

			<button
				onClick={onTogglePause}
				className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
					paused
						? "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
						: "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
				}`}
			>
				{paused ? "Resume" : "Pause"}
			</button>
		</div>
	);
}
