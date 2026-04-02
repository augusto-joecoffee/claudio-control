import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ReviewSession } from "./types";

const CONFIG_DIR = join(homedir(), ".claude-control");
const REVIEW_DIR = join(CONFIG_DIR, "reviews");

const EMPTY_REVIEW: ReviewSession = {
	sessionId: "",
	workingDirectory: "",
	baseBranch: "main",
	mergeBase: "",
	comments: [],
	queueHead: 0,
	createdAt: new Date().toISOString(),
};

const cache = new Map<string, { data: ReviewSession; mtime: number }>();

function reviewPath(sessionId: string): string {
	return join(REVIEW_DIR, `${sessionId}.json`);
}

export async function loadReview(sessionId: string): Promise<ReviewSession | null> {
	const file = reviewPath(sessionId);
	try {
		const s = await stat(file);
		const cached = cache.get(sessionId);
		if (cached && cached.mtime === s.mtimeMs) return cached.data;

		const raw = await readFile(file, "utf-8");
		const data: ReviewSession = { ...EMPTY_REVIEW, ...JSON.parse(raw) };
		cache.set(sessionId, { data, mtime: s.mtimeMs });
		return data;
	} catch {
		return null;
	}
}

export async function saveReview(sessionId: string, review: ReviewSession): Promise<void> {
	await mkdir(REVIEW_DIR, { recursive: true });
	const file = reviewPath(sessionId);
	await writeFile(file, JSON.stringify(review, null, 2));
	const s = await stat(file);
	cache.set(sessionId, { data: review, mtime: s.mtimeMs });
}

export async function deleteReview(sessionId: string): Promise<void> {
	cache.delete(sessionId);
	try {
		await unlink(reviewPath(sessionId));
	} catch {
		// Already deleted
	}
}
