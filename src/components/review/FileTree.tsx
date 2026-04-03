"use client";

import { memo } from "react";
import type { FileData } from "react-diff-view";

interface FileTreeProps {
	files: FileData[];
	selectedFile: string | null;
	commentCounts: Record<string, number>;
	onSelectFile: (path: string | null) => void;
	onCollapse?: () => void;
	isViewed?: (path: string) => boolean;
	onToggleViewed?: (path: string) => void;
	viewedCount?: number;
	totalFiles?: number;
	uncommittedFiles?: Set<string>;
	isLoading?: boolean;
	githubCommentFiles?: Set<string>;
}

function fileStatus(type: string): { label: string; color: string } {
	switch (type) {
		case "add":
			return { label: "A", color: "text-emerald-400" };
		case "delete":
			return { label: "D", color: "text-red-400" };
		case "rename":
			return { label: "R", color: "text-blue-400" };
		case "copy":
			return { label: "C", color: "text-blue-400" };
		default:
			return { label: "M", color: "text-amber-400" };
	}
}

function countChanges(file: FileData): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const hunk of file.hunks) {
		for (const change of hunk.changes) {
			if (change.type === "insert") additions++;
			else if (change.type === "delete") deletions++;
		}
	}
	return { additions, deletions };
}

export const FileTree = memo(function FileTree({ files, selectedFile, commentCounts, onSelectFile, onCollapse, isViewed, onToggleViewed, viewedCount, totalFiles, uncommittedFiles, isLoading, githubCommentFiles }: FileTreeProps) {
	return (
		<div className="flex flex-col h-full">
			<div className="px-3 py-2 border-b border-zinc-800/50 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
						Files {isLoading ? "" : `(${files.length})`}
					</h2>
					{viewedCount != null && totalFiles != null && totalFiles > 0 && (
						<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
							viewedCount === totalFiles
								? "bg-emerald-500/15 text-emerald-400"
								: "bg-zinc-700/50 text-zinc-500"
						}`}>
							{viewedCount}/{totalFiles}
						</span>
					)}
				</div>
				{onCollapse && (
					<button onClick={onCollapse} className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5" title="Hide files">
						<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
						</svg>
					</button>
				)}
			</div>
			<div className="flex-1 overflow-y-auto py-1">
				{isLoading && files.length === 0 && (
					Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="flex items-center gap-2 px-3 py-1.5 border-l-2 border-transparent animate-pulse">
							<div className="w-3.5 h-3.5 rounded bg-zinc-800/80 shrink-0" />
							<div className="w-3 h-3 rounded bg-zinc-800/60 shrink-0" />
							<div className="h-3 rounded bg-zinc-800/50 flex-1" style={{ maxWidth: `${50 + (i * 17) % 80}%` }} />
							<div className="h-3 w-8 rounded bg-zinc-800/40 shrink-0" />
						</div>
					))
				)}
				{files.map((file) => {
					const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
					const { label, color } = fileStatus(file.type);
					const { additions, deletions } = countChanges(file);
					const comments = commentCounts[filePath] ?? 0;
					const isSelected = selectedFile === filePath;
					const viewed = isViewed?.(filePath) ?? false;
					const isUncommitted = uncommittedFiles?.has(filePath) ?? false;

					return (
						<div
							key={filePath}
							className={`w-full flex items-center gap-1 text-xs hover:bg-white/5 transition-colors ${
								isSelected ? "bg-white/8 border-l-2 border-violet-500" : "border-l-2 border-transparent"
							} ${viewed ? "opacity-50" : ""}`}
						>
							{onToggleViewed && (
								<button
									onClick={(e) => { e.stopPropagation(); onToggleViewed(filePath); }}
									className="pl-2 py-1.5 text-zinc-600 hover:text-emerald-400 transition-colors shrink-0"
									title={viewed ? "Mark as unviewed" : "Mark as viewed"}
								>
									<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
										{viewed ? (
											<path d="M4.5 12.75l6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round" fill="none" className="text-emerald-400" />
										) : (
											<rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
										)}
									</svg>
								</button>
							)}
							<button
								onClick={() => onSelectFile(isSelected ? null : filePath)}
								className={`flex-1 text-left ${onToggleViewed ? "pl-0" : "pl-3"} pr-3 py-1.5 flex items-center gap-2 min-w-0`}
							>
								<span className={`font-mono font-bold text-[10px] w-3 shrink-0 ${color}`}>{label}</span>
								<span className="truncate flex-1 text-zinc-300" title={filePath}>
									{filePath.split("/").pop()}
								</span>
								{isUncommitted && (
									<span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Uncommitted changes" />
								)}
								<span className="flex items-center gap-1 shrink-0">
									{additions > 0 && <span className="text-emerald-500 text-[10px]">+{additions}</span>}
									{deletions > 0 && <span className="text-red-500 text-[10px]">-{deletions}</span>}
									{comments > 0 && (
										<span className="ml-1 bg-violet-500/20 text-violet-300 rounded-full px-1.5 text-[10px]">
											{comments}
										</span>
									)}
									{githubCommentFiles?.has(filePath) && (
										<span title="Has PR comments"><svg className="ml-0.5 w-3 h-3 text-blue-400 shrink-0" viewBox="0 0 16 16" fill="currentColor">
											<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 01-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 010 8c0-4.42 3.58-8 8-8z" />
										</svg></span>
									)}
								</span>
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
});
