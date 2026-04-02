"use client";

import { useParams } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState, useTransition } from "react";
import type { ViewType } from "react-diff-view";
import { useReview } from "@/hooks/useReview";
import { useReviewDiff } from "@/hooks/useReviewDiff";
import { useReviewQueue } from "@/hooks/useReviewQueue";
import { useReviewCommits } from "@/hooks/useReviewCommits";
import { DiffViewer, parseDiff, getFilePath } from "@/components/review/DiffViewer";
import { FileTree } from "@/components/review/FileTree";
import { CommentQueue } from "@/components/review/CommentQueue";
import { ReviewToolbar } from "@/components/review/ReviewToolbar";

export default function ReviewPage() {
	const params = useParams();
	const sessionId = typeof params.sessionId === "string" ? decodeURIComponent(params.sessionId) : "";

	const { review, comments, addComment, refresh: refreshReview } = useReview(sessionId);
	const [selectedCommit, setSelectedCommit] = useState("all");
	const { diff, isLoading: diffLoading, refreshDiff } = useReviewDiff(sessionId, selectedCommit);
	const { commits } = useReviewCommits(sessionId);

	const [paused, setPaused] = useState(false);
	const [viewType, setViewType] = useState<ViewType>("split");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [activeComment, setActiveComment] = useState<{ filePath: string; line: number } | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);

	const pendingSnippetRef = useRef("");

	const handleRefreshDiff = useCallback(async () => {
		setIsRefreshing(true);
		await refreshDiff();
		setIsRefreshing(false);
	}, [refreshDiff]);

	const handleCommentResolved = useCallback(() => {
		refreshReview();
		handleRefreshDiff();
	}, [refreshReview, handleRefreshDiff]);

	const { processingId, pendingCount, completedCount, sessionStatus, refresh: refreshQueue } = useReviewQueue(sessionId, {
		paused,
		onCommentResolved: handleCommentResolved,
	});

	const files = useMemo(() => {
		if (!diff) return [];
		try {
			return parseDiff(diff);
		} catch {
			return [];
		}
	}, [diff]);

	const commentCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const c of comments) {
			counts[c.filePath] = (counts[c.filePath] ?? 0) + 1;
		}
		return counts;
	}, [comments]);

	const handleGutterClick = useCallback((filePath: string, line: number, anchorSnippet: string) => {
		setActiveComment((prev) => {
			if (prev?.filePath === filePath && prev?.line === line) return null;
			return { filePath, line };
		});
		pendingSnippetRef.current = anchorSnippet;
	}, []);

	const handleSubmitComment = useCallback(
		async (content: string) => {
			if (!activeComment) return;
			await addComment(activeComment.filePath, activeComment.line, content, pendingSnippetRef.current);
			setActiveComment(null);
			pendingSnippetRef.current = "";
			refreshQueue();
		},
		[activeComment, addComment, refreshQueue],
	);

	const handleCancelComment = useCallback(() => {
		setActiveComment(null);
	}, []);

	const handleCommentAction = useCallback(
		async (commentId: string, action: "resolve" | "delete") => {
			await fetch(`/api/review/${encodeURIComponent(sessionId)}/comments`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ commentId, action }),
			});
			refreshReview();
		},
		[sessionId, refreshReview],
	);

	const handleResolveComment = useCallback((id: string) => handleCommentAction(id, "resolve"), [handleCommentAction]);
	const handleDeleteComment = useCallback((id: string) => handleCommentAction(id, "delete"), [handleCommentAction]);

	const [, startTransition] = useTransition();

	const handleToggleView = useCallback(() => {
		startTransition(() => {
			setViewType((v) => (v === "split" ? "unified" : "split"));
		});
	}, [startTransition]);

	const handleTogglePause = useCallback(() => {
		setPaused((p) => !p);
	}, []);

	const handleSelectCommit = useCallback((hash: string) => {
		setSelectedCommit(hash);
		setSelectedFile(null);
	}, []);

	if (!review && !diffLoading) {
		return (
			<div className="h-screen flex items-center justify-center text-zinc-500">
				<div className="text-center">
					<div className="text-lg mb-2">Loading review...</div>
					<div className="text-xs">Initializing review session</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-screen flex flex-col bg-[#050508]">
			{/* Toolbar */}
			<ReviewToolbar
				sessionName={review?.workingDirectory.split("/").pop() ?? sessionId}
				baseBranch={review?.baseBranch ?? "main"}
				viewType={viewType}
				onToggleView={handleToggleView}
				onRefreshDiff={handleRefreshDiff}
				isRefreshing={isRefreshing}
				commits={commits}
				selectedCommit={selectedCommit}
				onSelectCommit={handleSelectCommit}
			/>

			{/* Main content */}
			<div className="flex-1 flex min-h-0">
				{/* File tree sidebar */}
				<div className="w-[250px] border-r border-zinc-800/50 bg-[#0a0a0f]/50 overflow-hidden flex flex-col">
					<FileTree
						files={files}
						selectedFile={selectedFile}
						commentCounts={commentCounts}
						onSelectFile={setSelectedFile}
					/>
				</div>

				{/* Diff viewer */}
				{diffLoading ? (
					<div className="flex-1 flex items-center justify-center text-zinc-600">
						<span className="flex items-center gap-2">
							<span className="w-4 h-4 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
							Loading diff...
						</span>
					</div>
				) : (
					<DiffViewer
						rawDiff={diff}
						viewType={viewType}
						comments={comments}
						activeCommentLocation={activeComment}
						onGutterClick={handleGutterClick}
						onSubmitComment={handleSubmitComment}
						onCancelComment={handleCancelComment}
						onResolveComment={handleResolveComment}
						onDeleteComment={handleDeleteComment}
						selectedFile={selectedFile}
					/>
				)}
			</div>

			{/* Bottom queue bar */}
			<CommentQueue
				pendingCount={pendingCount}
				processingId={processingId}
				completedCount={completedCount}
				sessionStatus={sessionStatus}
				paused={paused}
				onTogglePause={handleTogglePause}
			/>
		</div>
	);
}
