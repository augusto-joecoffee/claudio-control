"use client";

import { memo, useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { ReviewComment, ReviewCommentStatus } from "@/lib/types";

interface CommentInputProps {
	onSubmit: (content: string) => void;
	onCancel: () => void;
	placeholder?: string;
}

function CommentInput({ onSubmit, onCancel, placeholder = "Write a review comment..." }: CommentInputProps) {
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
				placeholder={placeholder}
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

/** Render markdown-ish text: code blocks, inline code, bold, and paragraphs. */
function FormattedText({ text }: { text: string }) {
	const parts = useMemo(() => {
		const result: React.ReactNode[] = [];
		// Split on fenced code blocks first
		const segments = text.split(/(```[\s\S]*?```)/g);
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (seg.startsWith("```")) {
				const inner = seg.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
				result.push(
					<pre key={i} className="my-1.5 px-2.5 py-2 rounded bg-zinc-900 border border-zinc-800/50 text-[11px] text-zinc-300 overflow-x-auto font-mono">
						{inner}
					</pre>,
				);
			} else if (seg.trim()) {
				// Process inline formatting: `code`, **bold**, *italic*
				const inlineParts = seg.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
				const formatted = inlineParts.map((part, j) => {
					if (part.startsWith("`") && part.endsWith("`")) {
						return <code key={j} className="px-1 py-0.5 rounded bg-zinc-800 text-emerald-300 text-[11px] font-mono">{part.slice(1, -1)}</code>;
					}
					if (part.startsWith("**") && part.endsWith("**")) {
						return <strong key={j} className="text-zinc-200">{part.slice(2, -2)}</strong>;
					}
					return part;
				});
				result.push(<span key={i} className="whitespace-pre-wrap">{formatted}</span>);
			}
		}
		return result;
	}, [text]);

	return <div className="text-xs text-zinc-300 leading-relaxed">{parts}</div>;
}

const statusConfig: Record<ReviewCommentStatus, { label: string; color: string; bg: string }> = {
	pending: { label: "Pending", color: "text-zinc-400", bg: "bg-zinc-700/50" },
	sending: { label: "Sending...", color: "text-amber-400", bg: "bg-amber-500/10" },
	processing: { label: "Processing", color: "text-blue-400", bg: "bg-blue-500/10" },
	answered: { label: "Answered", color: "text-violet-400", bg: "bg-violet-500/10" },
	resolved: { label: "Resolved", color: "text-emerald-400", bg: "bg-emerald-500/10" },
};

interface CommentDisplayProps {
	comment: ReviewComment;
	replies: ReviewComment[];
	onResolve?: (id: string) => void;
	onDelete?: (id: string) => void;
	onReply?: (parentId: string, content: string) => void;
}

const CommentDisplay = memo(function CommentDisplay({ comment, replies, onResolve, onDelete, onReply }: CommentDisplayProps) {
	const { label, color, bg } = statusConfig[comment.status];
	const [minimized, setMinimized] = useState(comment.status === "resolved");
	const [replyingTo, setReplyingTo] = useState(false);

	const handleReplySubmit = useCallback((content: string) => {
		onReply?.(comment.id, content);
		setReplyingTo(false);
	}, [comment.id, onReply]);

	const handleReplyCancel = useCallback(() => {
		setReplyingTo(false);
	}, []);

	return (
		<div className={`mx-2 my-1.5 rounded-lg border overflow-hidden ${
			comment.status === "resolved" ? "border-zinc-800/30 bg-zinc-900/30 opacity-60" : "border-zinc-700/50 bg-zinc-900/50"
		}`}>
			<div className="flex items-center justify-between px-2.5 py-1.5 border-b border-zinc-800/50">
				<span className="text-[10px] text-zinc-500">
					{new Date(comment.createdAt).toLocaleTimeString()}
				</span>
				<div className="flex items-center gap-1.5">
					<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${bg} ${color}`}>
						{label}
						{comment.status === "processing" && (
							<span className="inline-block ml-1 w-2 h-2 rounded-full border border-blue-400 border-t-transparent animate-spin" />
						)}
					</span>
					{/* Minimize toggle */}
					<button
						onClick={() => setMinimized((m) => !m)}
						className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5"
						title={minimized ? "Expand" : "Minimize"}
					>
						<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							{minimized
								? <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
								: <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
							}
						</svg>
					</button>
					{/* Resolve */}
					{comment.status !== "resolved" && comment.status !== "pending" && comment.status !== "processing" && onResolve && (
						<button
							onClick={() => { onResolve(comment.id); setMinimized(true); }}
							className="text-zinc-600 hover:text-emerald-400 transition-colors p-0.5"
							title="Resolve"
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
							</svg>
						</button>
					)}
					{/* Delete */}
					{onDelete && (
						<button
							onClick={() => onDelete(comment.id)}
							className="text-zinc-600 hover:text-red-400 transition-colors p-0.5"
							title="Delete"
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					)}
				</div>
			</div>
			{!minimized && (
				<>
					<div className="px-2.5 py-2 text-xs text-zinc-300 whitespace-pre-wrap">{comment.content}</div>
					{comment.response && (
						<div className="px-2.5 py-2 border-t border-zinc-800/50 bg-emerald-500/5">
							<div className="text-[10px] text-emerald-500 mb-1.5 font-medium">Claude's response:</div>
							<FormattedText text={comment.response} />
						</div>
					)}
					{/* Replies */}
					{replies.length > 0 && (
						<div className="border-t border-zinc-800/50">
							{replies.map((reply) => {
								const rs = statusConfig[reply.status];
								return (
									<div key={reply.id} className="border-t border-zinc-800/30 first:border-t-0">
										<div className="flex items-center justify-between px-2.5 py-1 bg-zinc-900/30">
											<span className="text-[10px] text-zinc-600">
												Reply · {new Date(reply.createdAt).toLocaleTimeString()}
											</span>
											<div className="flex items-center gap-1.5">
												<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${rs.bg} ${rs.color}`}>
													{rs.label}
													{reply.status === "processing" && (
														<span className="inline-block ml-1 w-2 h-2 rounded-full border border-blue-400 border-t-transparent animate-spin" />
													)}
												</span>
												{onDelete && (
													<button
														onClick={() => onDelete(reply.id)}
														className="text-zinc-600 hover:text-red-400 transition-colors p-0.5"
														title="Delete reply"
													>
														<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
															<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
														</svg>
													</button>
												)}
											</div>
										</div>
										<div className="px-2.5 py-1.5 text-xs text-zinc-300 whitespace-pre-wrap">{reply.content}</div>
										{reply.response && (
											<div className="px-2.5 py-1.5 bg-emerald-500/5">
												<div className="text-[10px] text-emerald-500 mb-1 font-medium">Claude's response:</div>
												<FormattedText text={reply.response} />
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
					{/* Reply button / input */}
					{onReply && comment.status !== "resolved" && !replyingTo && (
						<div className="border-t border-zinc-800/50 px-2.5 py-1.5">
							<button
								onClick={() => setReplyingTo(true)}
								className="text-[11px] text-zinc-500 hover:text-violet-400 transition-colors flex items-center gap-1"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
								</svg>
								Reply
							</button>
						</div>
					)}
					{replyingTo && (
						<div className="border-t border-zinc-800/50">
							<CommentInput onSubmit={handleReplySubmit} onCancel={handleReplyCancel} placeholder="Write a reply..." />
						</div>
					)}
				</>
			)}
		</div>
	);
});

interface CommentThreadProps {
	comments: ReviewComment[];
	isAddingComment: boolean;
	onSubmitComment: (content: string) => void;
	onCancelComment: () => void;
	onResolveComment?: (id: string) => void;
	onDeleteComment?: (id: string) => void;
	onReplyComment?: (parentId: string, content: string) => void;
}

export const CommentThread = memo(function CommentThread({ comments, isAddingComment, onSubmitComment, onCancelComment, onResolveComment, onDeleteComment, onReplyComment }: CommentThreadProps) {
	// Separate root comments from replies
	const { roots, repliesByParent } = useMemo(() => {
		const roots: ReviewComment[] = [];
		const repliesByParent = new Map<string, ReviewComment[]>();
		for (const c of comments) {
			if (c.parentId) {
				const arr = repliesByParent.get(c.parentId) ?? [];
				arr.push(c);
				repliesByParent.set(c.parentId, arr);
			} else {
				roots.push(c);
			}
		}
		return { roots, repliesByParent };
	}, [comments]);

	return (
		<div className="py-0.5">
			{roots.map((comment) => (
				<CommentDisplay
					key={comment.id}
					comment={comment}
					replies={repliesByParent.get(comment.id) ?? []}
					onResolve={onResolveComment}
					onDelete={onDeleteComment}
					onReply={onReplyComment}
				/>
			))}
			{isAddingComment && <CommentInput onSubmit={onSubmitComment} onCancel={onCancelComment} />}
		</div>
	);
});
