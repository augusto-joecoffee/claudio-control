"use client";

import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ViewType } from "react-diff-view";
import { useSession } from "@/hooks/useSession";
import { useReview } from "@/hooks/useReview";
import { useReviewDiff } from "@/hooks/useReviewDiff";
import { useReviewQueue } from "@/hooks/useReviewQueue";
import { useReviewCommits } from "@/hooks/useReviewCommits";
import { useReviewBranches } from "@/hooks/useReviewBranches";
import { useViewedFiles } from "@/hooks/useViewedFiles";
import { useAutoRefreshDiff } from "@/hooks/useAutoRefreshDiff";
import { useGitHubComments } from "@/hooks/useGitHubComments";
import { DiffViewer, parseDiff, getFilePath } from "@/components/review/DiffViewer";
import { FileTree } from "@/components/review/FileTree";
import { CommentQueue } from "@/components/review/CommentQueue";
import { ReviewToolbar } from "@/components/review/ReviewToolbar";

export default function ReviewPage() {
	const params = useParams();
	const sessionId = typeof params.sessionId === "string" ? decodeURIComponent(params.sessionId) : "";

	// Close the review window when the session disappears (killed or exited)
	const { error: sessionError } = useSession(sessionId);
	const sessionGoneCount = useRef(0);
	useEffect(() => {
		if (!sessionId) return;
		if (!sessionError) {
			sessionGoneCount.current = 0;
			return;
		}
		// Session returned an error (404) — count consecutive failures
		sessionGoneCount.current++;
		if (sessionGoneCount.current >= 2) {
			const api = (window as unknown as { electronAPI?: { closeReviewWindow: (id: string) => Promise<void> } }).electronAPI;
			if (api?.closeReviewWindow) {
				api.closeReviewWindow(sessionId);
			} else {
				window.close();
			}
		}
	}, [sessionId, sessionError]);

	const { review, comments, addComment, refresh: refreshReview } = useReview(sessionId);
	const [selectedCommit, setSelectedCommit] = useState("all");
	const { diff, isLoading: diffLoading, refreshDiff, uncommittedFiles } = useReviewDiff(sessionId, selectedCommit);
	const { commits } = useReviewCommits(sessionId);
	const { branches } = useReviewBranches(sessionId);

	const { comments: githubComments, refresh: refreshGitHubComments, replyToThread, resolveThread } = useGitHubComments(sessionId, review?.prUrl);

	const [paused, setPaused] = useState(false);
	const [viewType, setViewType] = useState<ViewType>("split");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [activeComment, setActiveComment] = useState<{ filePath: string; startLine: number; endLine: number } | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [showGitHubComments, setShowGitHubComments] = useState(true);

	const pendingSnippetRef = useRef("");

	const handleRefreshDiff = useCallback(async () => {
		setIsRefreshing(true);
		await refreshDiff();
		setIsRefreshing(false);
	}, [refreshDiff]);

	useAutoRefreshDiff(sessionId, refreshDiff);

	const handleCommentResolved = useCallback(() => {
		refreshReview();
		handleRefreshDiff();
		// Refresh GitHub comments — a reply to a GitHub thread may have been posted
		if (review?.prUrl) {
			fetch(`/api/review/${encodeURIComponent(sessionId)}/github-comments?fresh=1`)
				.then((r) => r.json())
				.then((data) => refreshGitHubComments(data, { revalidate: false }))
				.catch(() => {});
		}
	}, [refreshReview, handleRefreshDiff, review?.prUrl, sessionId, refreshGitHubComments]);

	const { processingId, pendingCount, completedCount, sessionStatus, refresh: refreshQueue } = useReviewQueue(sessionId, {
		paused,
		onCommentResolved: handleCommentResolved,
	});

	// Refresh review data when a comment starts processing so the status
	// badge updates from "Pending" to "Processing" without waiting for the
	// next SWR revalidation cycle.
	useEffect(() => {
		if (processingId) refreshReview();
	}, [processingId, refreshReview]);

	const files = useMemo(() => {
		if (!diff) return [];
		try {
			return parseDiff(diff);
		} catch {
			return [];
		}
	}, [diff]);

	const { viewedCount, toggleViewed, isViewed } = useViewedFiles(sessionId, files);

	const uncommittedSet = useMemo(() => new Set(uncommittedFiles), [uncommittedFiles]);

	const commentCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const c of comments) {
			if (c.githubThreadId) continue; // GitHub thread replies are shown in the GitHub comment, not separately
			counts[c.filePath] = (counts[c.filePath] ?? 0) + 1;
		}
		return counts;
	}, [comments]);

	const githubCommentFiles = useMemo(() => {
		// Build lookup: oldPath → newPath for renames, plus filename → newPath for moved files
		const oldToNew = new Map<string, string>();
		const nameToNew = new Map<string, string>();
		for (const f of files) {
			const newPath = f.newPath === "/dev/null" ? f.oldPath : f.newPath;
			if (f.oldPath && f.oldPath !== f.newPath && f.oldPath !== "/dev/null") {
				oldToNew.set(f.oldPath, newPath);
			}
			const name = newPath.split("/").pop() ?? "";
			if (name) nameToNew.set(name, newPath);
		}
		const result = new Set<string>();
		for (const c of githubComments) {
			// Try exact path, then old→new rename, then match by filename
			const fileName = c.path.split("/").pop() ?? "";
			result.add(oldToNew.get(c.path) ?? nameToNew.get(fileName) ?? c.path);
		}
		return result;
	}, [githubComments, files]);

	const handleGutterClick = useCallback((filePath: string, startLine: number, endLine: number, anchorSnippet: string) => {
		setActiveComment((prev) => {
			if (prev?.filePath === filePath && prev?.startLine === startLine && prev?.endLine === endLine) return null;
			return { filePath, startLine, endLine };
		});
		pendingSnippetRef.current = anchorSnippet;
	}, []);

	const handleSubmitComment = useCallback(
		async (content: string) => {
			if (!activeComment) return;
			const endLine = activeComment.startLine !== activeComment.endLine ? activeComment.endLine : undefined;
			await addComment(activeComment.filePath, activeComment.startLine, content, pendingSnippetRef.current, endLine);
			setActiveComment(null);
			pendingSnippetRef.current = "";
			refreshQueue();
		},
		[activeComment, addComment, refreshQueue],
	);

	const handleCancelComment = useCallback(() => {
		setActiveComment(null);
	}, []);

	const handleReplyComment = useCallback(
		async (parentId: string, content: string) => {
			// Find the parent comment to get its file/line context
			const parent = comments.find((c) => c.id === parentId);
			if (!parent) return;
			await addComment(parent.filePath, parent.line, content, parent.anchorSnippet, parent.endLine, parentId);
			refreshQueue();
		},
		[comments, addComment, refreshQueue],
	);

	const handleReplyGitHubComment = useCallback(
		async (threadId: string, content: string) => {
			// Find the GitHub comment to get file/line context
			const ghComment = githubComments.find((c) => c.threadId === threadId);
			if (!ghComment) return;

			// Optimistic update — show the reply in the GitHub thread immediately
			refreshGitHubComments(
				(current) => {
					if (!current) return current;
					return {
						comments: current.comments.map((c) =>
							c.threadId === threadId
								? { ...c, replies: [...c.replies, { id: `optimistic-${Date.now()}`, author: "you", body: content, createdAt: new Date().toISOString() }] }
								: c,
						),
					};
				},
				{ revalidate: false },
			);

			// Store the GitHub comment body + author as anchorSnippet so the queue
			// can include it in the prompt for Claude
			const ghContext = `@${ghComment.author}: ${ghComment.body}\n\nGitHub URL: ${ghComment.url}`;
			await addComment(ghComment.path, ghComment.line, content, ghContext, undefined, undefined, threadId);
			refreshQueue();
		},
		[githubComments, addComment, refreshQueue, refreshGitHubComments],
	);

	const handleResolveGitHubThread = useCallback(
		async (threadId: string) => {
			await resolveThread(threadId);
			refreshGitHubComments();
		},
		[resolveThread, refreshGitHubComments],
	);

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

	const handleChangeBaseBranch = useCallback(async (branch: string) => {
		await fetch(`/api/review/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ baseBranch: branch }),
		});
		refreshReview();
		refreshDiff();
	}, [sessionId, refreshReview, refreshDiff]);

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

	const handleOpenInEditor = useCallback((filePath: string) => {
		const cwd = review?.workingDirectory;
		if (!cwd) return;
		const fullPath = `${cwd}/${filePath}`;
		fetch("/api/actions/open", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "editor", path: fullPath }),
		}).catch(() => {});
	}, [review?.workingDirectory]);

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
				branches={branches}
				onChangeBaseBranch={handleChangeBaseBranch}
				viewType={viewType}
				onToggleView={handleToggleView}
				onRefreshDiff={handleRefreshDiff}
				isRefreshing={isRefreshing}
				commits={commits}
				selectedCommit={selectedCommit}
				onSelectCommit={handleSelectCommit}
				hasPrComments={githubComments.length > 0}
				showGitHubComments={showGitHubComments}
				onToggleGitHubComments={() => setShowGitHubComments((v) => !v)}
				gitHubCommentCount={githubComments.length}
			/>

			{/* Main content */}
			<div className="flex-1 flex min-h-0">
				{/* File tree sidebar */}
				{sidebarOpen ? (
					<div className="w-[250px] border-r border-zinc-800/50 bg-[#0a0a0f]/50 overflow-hidden flex flex-col shrink-0">
						<FileTree
							files={files}
							selectedFile={selectedFile}
							commentCounts={commentCounts}
							onSelectFile={setSelectedFile}
							onCollapse={() => setSidebarOpen(false)}
							isViewed={isViewed}
							onToggleViewed={toggleViewed}
							viewedCount={viewedCount}
							totalFiles={files.length}
							uncommittedFiles={uncommittedSet}
							isLoading={diffLoading}
							githubCommentFiles={showGitHubComments ? githubCommentFiles : undefined}
						/>
					</div>
				) : (
					<button
						onClick={() => setSidebarOpen(true)}
						className="w-6 flex items-start pt-2.5 justify-center border-r border-zinc-800/50 bg-[#0a0a0f]/30 text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors shrink-0"
						title="Show files"
					>
						<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
						</svg>
					</button>
				)}

				{/* Diff viewer */}
				<DiffViewer
					rawDiff={diff}
					viewType={viewType}
					comments={comments}
					githubComments={showGitHubComments ? githubComments : undefined}
					activeCommentLocation={activeComment}
					onGutterClick={handleGutterClick}
					onSubmitComment={handleSubmitComment}
					onCancelComment={handleCancelComment}
					onResolveComment={handleResolveComment}
					onDeleteComment={handleDeleteComment}
					onReplyComment={handleReplyComment}
					onReplyGitHubComment={handleReplyGitHubComment}
					onResolveGitHubThread={handleResolveGitHubThread}
					selectedFile={selectedFile}
					isViewed={isViewed}
					onToggleViewed={toggleViewed}
					sessionId={sessionId}
					onOpenInEditor={handleOpenInEditor}
					isLoading={diffLoading}
				/>
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
