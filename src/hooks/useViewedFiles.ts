import { useCallback, useEffect, useState } from "react";
import type { FileData, HunkData } from "react-diff-view";

const STORAGE_KEY = "review-viewed-files";

/** Simple hash of a file's diff hunks — changes when the diff content changes. */
function hashHunks(hunks: HunkData[]): string {
	let h = 0;
	for (const hunk of hunks) {
		for (const change of hunk.changes) {
			const s = change.content;
			for (let i = 0; i < s.length; i++) {
				h = ((h << 5) - h + s.charCodeAt(i)) | 0;
			}
		}
	}
	return h.toString(36);
}

// Storage: { [filePath]: diffHash }
type ViewedMap = Record<string, string>;

function loadViewed(sessionId: string): ViewedMap {
	try {
		const raw = localStorage.getItem(`${STORAGE_KEY}:${sessionId}`);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		// Migrate from old format (string[])
		if (Array.isArray(parsed)) {
			const map: ViewedMap = {};
			for (const fp of parsed) map[fp] = "";
			return map;
		}
		return parsed;
	} catch {
		return {};
	}
}

function saveViewed(sessionId: string, viewed: ViewedMap) {
	localStorage.setItem(`${STORAGE_KEY}:${sessionId}`, JSON.stringify(viewed));
}

function getFilePath(file: FileData): string {
	return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}

export function useViewedFiles(sessionId: string, files: FileData[]) {
	const [viewed, setViewed] = useState<ViewedMap>(() => loadViewed(sessionId));

	// Auto-unmark files whose diff has changed since they were marked viewed.
	useEffect(() => {
		if (files.length === 0) return;

		setViewed((prev) => {
			const stale: string[] = [];
			for (const file of files) {
				const fp = getFilePath(file);
				const storedHash = prev[fp];
				if (storedHash === undefined) continue; // not viewed
				if (storedHash === "") continue; // migrated entry, no hash to compare
				const currentHash = hashHunks(file.hunks);
				if (storedHash !== currentHash) stale.push(fp);
			}
			if (stale.length === 0) return prev;

			const next = { ...prev };
			for (const fp of stale) delete next[fp];
			saveViewed(sessionId, next);
			return next;
		});
	}, [files, sessionId]);

	const toggleViewed = useCallback(
		(filePath: string) => {
			setViewed((prev) => {
				const next = { ...prev };
				if (filePath in next) {
					delete next[filePath];
				} else {
					// Find the file and compute its hash
					const file = files.find((f) => getFilePath(f) === filePath);
					next[filePath] = file ? hashHunks(file.hunks) : "";
				}
				saveViewed(sessionId, next);
				return next;
			});
		},
		[sessionId, files],
	);

	const isViewed = useCallback((filePath: string) => filePath in viewed, [viewed]);

	const viewedCount = Object.keys(viewed).length;

	return { viewedCount, toggleViewed, isViewed };
}
