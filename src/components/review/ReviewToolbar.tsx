"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
}

interface ReviewToolbarProps {
	sessionName: string;
	baseBranch: string;
	branches: string[];
	onChangeBaseBranch: (branch: string) => void;
	viewType: "split" | "unified";
	onToggleView: () => void;
	onRefreshDiff: () => void;
	isRefreshing: boolean;
	commits: CommitInfo[];
	selectedCommit: string;
	onSelectCommit: (hash: string) => void;
	hasPrComments?: boolean;
	showGitHubComments?: boolean;
	onToggleGitHubComments?: () => void;
	gitHubCommentCount?: number;
}

const btnClass =
	"h-8 px-3 text-xs rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors";

function BranchPicker({ value, branches, onChange }: { value: string; branches: string[]; onChange: (b: string) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const filtered = query
		? branches
			.filter((b) => b.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => {
				const al = a.toLowerCase(), bl = b.toLowerCase(), q = query.toLowerCase();
				const aStarts = al.startsWith(q) ? 0 : 1;
				const bStarts = bl.startsWith(q) ? 0 : 1;
				if (aStarts !== bStarts) return aStarts - bStarts;
				const aExact = al === q ? 0 : 1;
				const bExact = bl === q ? 0 : 1;
				if (aExact !== bExact) return aExact - bExact;
				return a.length - b.length || a.localeCompare(b);
			})
		: branches;

	const select = useCallback((b: string) => {
		onChange(b);
		setOpen(false);
		setQuery("");
	}, [onChange]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
				setQuery("");
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	return (
		<div ref={containerRef} className="relative">
			<button
				onClick={() => setOpen((o) => !o)}
				className="h-8 px-2 text-[11px] rounded-md border border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 transition-colors flex items-center gap-1.5 max-w-[140px]"
			>
				<svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
					<path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
				</svg>
				<span className="truncate">{value}</span>
			</button>
			{open && (
				<div className="absolute top-full left-0 mt-1 w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50">
					<div className="p-1.5">
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && filtered.length > 0) select(filtered[0]);
								if (e.key === "Escape") { setOpen(false); setQuery(""); }
							}}
							placeholder="Search branches..."
							className="w-full px-2 py-1.5 text-xs bg-zinc-800 text-zinc-200 rounded border border-zinc-700 outline-none placeholder-zinc-600"
						/>
					</div>
					<div className="max-h-48 overflow-y-auto">
						{filtered.map((b) => (
							<button
								key={b}
								onClick={() => select(b)}
								className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors ${
									b === value ? "text-violet-400" : "text-zinc-400"
								}`}
							>
								{b}
							</button>
						))}
						{filtered.length === 0 && (
							<div className="px-3 py-2 text-xs text-zinc-600">No matching branches</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export const ReviewToolbar = memo(function ReviewToolbar({
	sessionName,
	baseBranch,
	branches,
	onChangeBaseBranch,
	viewType,
	onToggleView,
	onRefreshDiff,
	isRefreshing,
	commits,
	selectedCommit,
	onSelectCommit,
	hasPrComments,
	showGitHubComments,
	onToggleGitHubComments,
	gitHubCommentCount,
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

			<BranchPicker value={baseBranch} branches={branches} onChange={onChangeBaseBranch} />

			<select
				value={selectedCommit}
				onChange={(e) => onSelectCommit(e.target.value)}
				className="h-8 px-2 text-xs rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 transition-colors outline-none max-w-[300px] truncate"
			>
				<option value="all">All changes</option>
				<option value="uncommitted">Uncommitted changes</option>
				<option value="committed">Unpushed commits</option>
				{commits.length > 0 && <option disabled>───────────</option>}
				{commits.map((c) => (
					<option key={c.hash} value={c.hash}>
						{c.shortHash} — {c.subject}
					</option>
				))}
			</select>

			<div className="flex-1" />

			{hasPrComments && onToggleGitHubComments && (
				<button
					onClick={onToggleGitHubComments}
					className={`h-8 px-3 text-xs rounded-md border flex items-center gap-1.5 transition-colors ${
						showGitHubComments
							? "border-blue-500/50 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
							: "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 line-through"
					}`}
					title={showGitHubComments ? "Hide PR comments" : "Show PR comments"}
				>
					<svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 01-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 010 8c0-4.42 3.58-8 8-8z" />
					</svg>
					PR{gitHubCommentCount ? ` (${gitHubCommentCount})` : ""}
				</button>
			)}

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
