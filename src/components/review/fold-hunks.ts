import type { ChangeData, HunkData } from "react-diff-view";
import type { FoldRegion } from "./fold-detection";

export interface CollapsedFold {
	key: string;              // "startLine-endLine"
	startLine: number;
	endLine: number;
	label: string;
	hiddenLineCount: number;
	hiddenChangeCount: number; // insert+delete changes only
}

export interface DisplayHunk {
	hunk: HunkData;
	originalHunkIndex: number;
	foldAfter?: CollapsedFold;
}

/** Get the new-side line number for a change, or null for delete-only lines. */
function newLine(change: ChangeData): number | null {
	if (change.type === "normal") return change.newLineNumber ?? null;
	if (change.type === "insert") return change.lineNumber ?? null;
	return null;
}

/**
 * Split hunks at collapsed fold boundaries, producing DisplayHunks.
 * When no folds are active, returns one DisplayHunk per original hunk (zero overhead path).
 */
export function applyFolds(
	hunks: HunkData[],
	foldedRegions: Set<string>,
	foldRegions: FoldRegion[],
): DisplayHunk[] {
	if (foldedRegions.size === 0) {
		return hunks.map((hunk, i) => ({ hunk, originalHunkIndex: i }));
	}

	// Build a set of active (collapsed) fold regions for quick lookup
	const activeFolds = foldRegions.filter((r) => foldedRegions.has(`${r.startLine}-${r.endLine}`));
	if (activeFolds.length === 0) {
		return hunks.map((hunk, i) => ({ hunk, originalHunkIndex: i }));
	}

	const result: DisplayHunk[] = [];

	for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
		const hunk = hunks[hunkIdx];
		const changes = hunk.changes;

		// Find which active folds overlap this hunk
		const hunkFolds = activeFolds.filter((fold) => {
			// Check if any change in this hunk falls within the fold
			for (const c of changes) {
				const ln = newLine(c);
				if (ln !== null && ln >= fold.startLine && ln <= fold.endLine) return true;
				// Also check old-side lines for deletes
				if (c.type === "delete" && c.lineNumber != null) {
					// We can't reliably map delete line numbers to fold ranges (they're old-side),
					// but if a delete is between two changes that are in the fold, it's included
				}
			}
			return false;
		});

		if (hunkFolds.length === 0) {
			result.push({ hunk, originalHunkIndex: hunkIdx });
			continue;
		}

		// Sort folds by startLine
		hunkFolds.sort((a, b) => a.startLine - b.startLine);

		// Split the hunk around each fold
		let currentChanges: ChangeData[] = [];
		let foldIdx = 0;
		let insideFold = false;
		let foldChanges: ChangeData[] = [];
		let currentFold: FoldRegion | null = null;

		for (const change of changes) {
			const ln = newLine(change);

			// Check if we're entering a fold
			if (!insideFold && foldIdx < hunkFolds.length && ln !== null && ln >= hunkFolds[foldIdx].startLine) {
				insideFold = true;
				currentFold = hunkFolds[foldIdx];
				foldChanges = [];
				// The fold start line itself is included in the visible part (shows the signature)
				if (ln === currentFold.startLine) {
					currentChanges.push(change);
					continue;
				}
			}

			// Check if we're exiting a fold
			if (insideFold && currentFold && ln !== null && ln > currentFold.endLine) {
				// Emit the pre-fold sub-hunk
				if (currentChanges.length > 0) {
					const subHunk = buildSubHunk(hunk, currentChanges, `fold-pre-${currentFold.startLine}`);
					const hiddenChangeCount = foldChanges.filter((c) => c.type === "insert" || c.type === "delete").length;
					result.push({
						hunk: subHunk,
						originalHunkIndex: hunkIdx,
						foldAfter: {
							key: `${currentFold.startLine}-${currentFold.endLine}`,
							startLine: currentFold.startLine,
							endLine: currentFold.endLine,
							label: currentFold.label,
							hiddenLineCount: foldChanges.length,
							hiddenChangeCount,
						},
					});
				}
				currentChanges = [change];
				foldChanges = [];
				insideFold = false;
				currentFold = null;
				foldIdx++;

				// Check if we immediately enter the next fold
				if (foldIdx < hunkFolds.length && ln >= hunkFolds[foldIdx].startLine) {
					insideFold = true;
					currentFold = hunkFolds[foldIdx];
					foldChanges = [];
					if (ln === currentFold.startLine) {
						// Keep it in currentChanges (visible)
						continue;
					}
				} else {
					continue;
				}
			}

			if (insideFold) {
				foldChanges.push(change);
			} else {
				currentChanges.push(change);
			}
		}

		// Handle fold that extends to end of hunk (no exit line found in this hunk)
		if (insideFold && currentFold && foldChanges.length > 0) {
			if (currentChanges.length > 0) {
				const subHunk = buildSubHunk(hunk, currentChanges, `fold-pre-${currentFold.startLine}`);
				const hiddenChangeCount = foldChanges.filter((c) => c.type === "insert" || c.type === "delete").length;
				result.push({
					hunk: subHunk,
					originalHunkIndex: hunkIdx,
					foldAfter: {
						key: `${currentFold.startLine}-${currentFold.endLine}`,
						startLine: currentFold.startLine,
						endLine: currentFold.endLine,
						label: currentFold.label,
						hiddenLineCount: foldChanges.length,
						hiddenChangeCount,
					},
				});
			}
		} else if (currentChanges.length > 0) {
			// Remaining changes after the last fold
			const suffix = foldIdx > 0 ? `fold-post-${hunkFolds[foldIdx - 1]?.endLine ?? "end"}` : "";
			const subHunk = suffix ? buildSubHunk(hunk, currentChanges, suffix) : buildSubHunk(hunk, currentChanges, "");
			result.push({ hunk: subHunk, originalHunkIndex: hunkIdx });
		}
	}

	return result;
}

/** Build a sub-hunk from a subset of changes, with a unique content key. */
function buildSubHunk(original: HunkData, changes: ChangeData[], suffix: string): HunkData {
	if (!suffix && changes.length === original.changes.length) {
		return original; // No split needed
	}
	const first = changes[0];
	const oldStart = first.type === "normal" ? (first.oldLineNumber ?? original.oldStart) :
		first.type === "delete" ? (first.lineNumber ?? original.oldStart) : original.oldStart;
	const newStart = first.type === "normal" ? (first.newLineNumber ?? original.newStart) :
		first.type === "insert" ? (first.lineNumber ?? original.newStart) : original.newStart;
	return {
		...original,
		content: suffix ? `${original.content} §${suffix}` : original.content,
		changes,
		oldStart,
		newStart,
	};
}
