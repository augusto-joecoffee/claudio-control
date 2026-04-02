"use client";

import { memo } from "react";
import type { FileData } from "react-diff-view";

interface FileTreeProps {
	files: FileData[];
	selectedFile: string | null;
	commentCounts: Record<string, number>;
	onSelectFile: (path: string) => void;
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

export const FileTree = memo(function FileTree({ files, selectedFile, commentCounts, onSelectFile }: FileTreeProps) {
	return (
		<div className="flex flex-col h-full">
			<div className="px-3 py-2 border-b border-zinc-800/50">
				<h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
					Files changed ({files.length})
				</h2>
			</div>
			<div className="flex-1 overflow-y-auto py-1">
				{files.map((file) => {
					const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
					const { label, color } = fileStatus(file.type);
					const { additions, deletions } = countChanges(file);
					const comments = commentCounts[filePath] ?? 0;
					const isSelected = selectedFile === filePath;

					return (
						<button
							key={filePath}
							onClick={() => onSelectFile(filePath)}
							className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors ${
								isSelected ? "bg-white/8 border-l-2 border-violet-500" : "border-l-2 border-transparent"
							}`}
						>
							<span className={`font-mono font-bold text-[10px] w-3 ${color}`}>{label}</span>
							<span className="truncate flex-1 text-zinc-300" title={filePath}>
								{filePath.split("/").pop()}
							</span>
							<span className="flex items-center gap-1 shrink-0">
								{additions > 0 && <span className="text-emerald-500 text-[10px]">+{additions}</span>}
								{deletions > 0 && <span className="text-red-500 text-[10px]">-{deletions}</span>}
								{comments > 0 && (
									<span className="ml-1 bg-violet-500/20 text-violet-300 rounded-full px-1.5 text-[10px]">
										{comments}
									</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
});
