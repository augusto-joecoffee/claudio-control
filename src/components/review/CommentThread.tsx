"use client";

import { memo, useState, useRef, useEffect } from "react";
import type { ReviewComment, ReviewCommentStatus } from "@/lib/types";

interface CommentInputProps {
	onSubmit: (content: string) => void;
	onCancel: () => void;
}

function CommentInput({ onSubmit, onCancel }: CommentInputProps) {
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (text.trim()) onSubmit(text.trim());
		} else if (e.key === "Escape") {
			e.preventDefault();
			onCancel();
		}
	};

	return (
		<div className="mx-2 my-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 overflow-hidden">
			<textarea
				ref={textareaRef}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Write a review comment..."
				className="w-full p-2.5 text-xs bg-transparent text-zinc-200 placeholder-zinc-600 resize-none outline-none min-h-[60px]"
				rows={3}
			/>
			<div className="flex items-center justify-between px-2.5 py-1.5 border-t border-violet-500/20 bg-violet-500/5">
				<span className="text-[10px] text-zinc-600">Cmd+Enter to submit · Esc to cancel</span>
				<div className="flex gap-1.5">
					<button
						onClick={onCancel}
						className="px-2.5 py-1 text-[11px] rounded-md bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={() => text.trim() && onSubmit(text.trim())}
						disabled={!text.trim()}
						className="px-2.5 py-1 text-[11px] rounded-md bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						Comment
					</button>
				</div>
			</div>
		</div>
	);
}

const statusConfig: Record<ReviewCommentStatus, { label: string; color: string; bg: string }> = {
	pending: { label: "Pending", color: "text-zinc-400", bg: "bg-zinc-700/50" },
	sending: { label: "Sending...", color: "text-amber-400", bg: "bg-amber-500/10" },
	processing: { label: "Processing", color: "text-blue-400", bg: "bg-blue-500/10" },
	resolved: { label: "Resolved", color: "text-emerald-400", bg: "bg-emerald-500/10" },
};

interface CommentDisplayProps {
	comment: ReviewComment;
}

const CommentDisplay = memo(function CommentDisplay({ comment }: CommentDisplayProps) {
	const { label, color, bg } = statusConfig[comment.status];

	return (
		<div className="mx-2 my-1.5 rounded-lg border border-zinc-700/50 bg-zinc-900/50 overflow-hidden">
			<div className="flex items-center justify-between px-2.5 py-1.5 border-b border-zinc-800/50">
				<span className="text-[10px] text-zinc-500">
					{new Date(comment.createdAt).toLocaleTimeString()}
				</span>
				<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${bg} ${color}`}>
					{label}
					{comment.status === "processing" && (
						<span className="inline-block ml-1 w-2 h-2 rounded-full border border-blue-400 border-t-transparent animate-spin" />
					)}
				</span>
			</div>
			<div className="px-2.5 py-2 text-xs text-zinc-300 whitespace-pre-wrap">{comment.content}</div>
			{comment.response && (
				<div className="px-2.5 py-2 border-t border-zinc-800/50 bg-emerald-500/5">
					<div className="text-[10px] text-emerald-500 mb-1 font-medium">Claude's response:</div>
					<div className="text-xs text-zinc-300 whitespace-pre-wrap">{comment.response}</div>
				</div>
			)}
		</div>
	);
});

interface CommentThreadProps {
	comments: ReviewComment[];
	isAddingComment: boolean;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
}

export const CommentThread = memo(function CommentThread({ comments, isAddingComment, onSubmitComment, onCancelComment }: CommentThreadProps) {
	return (
		<div className="py-0.5">
			{comments.map((comment) => (
				<CommentDisplay key={comment.id} comment={comment} />
			))}
			{isAddingComment && <CommentInput onSubmit={onSubmitComment} onCancel={onCancelComment} />}
		</div>
	);
});
