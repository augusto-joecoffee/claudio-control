import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { BehaviorAnalysis } from "./types";

const CONFIG_DIR = join(homedir(), ".claude-control");
const REVIEW_DIR = join(CONFIG_DIR, "reviews");

const cache = new Map<string, { data: BehaviorAnalysis; mtime: number }>();

let dirInitialized = false;
async function ensureDir() {
	if (dirInitialized) return;
	await mkdir(REVIEW_DIR, { recursive: true });
	dirInitialized = true;
}

function behaviorPath(sessionId: string): string {
	return join(REVIEW_DIR, `${sessionId}-behaviors.json`);
}

export async function loadBehaviorAnalysis(sessionId: string): Promise<BehaviorAnalysis | null> {
	const file = behaviorPath(sessionId);
	try {
		const s = await stat(file);
		const cached = cache.get(sessionId);
		if (cached && cached.mtime === s.mtimeMs) return cached.data;

		const raw = await readFile(file, "utf-8");
		const data: BehaviorAnalysis = JSON.parse(raw);
		cache.set(sessionId, { data, mtime: s.mtimeMs });
		return data;
	} catch {
		return null;
	}
}

export async function saveBehaviorAnalysis(sessionId: string, analysis: BehaviorAnalysis): Promise<void> {
	await ensureDir();
	const file = behaviorPath(sessionId);
	await writeFile(file, JSON.stringify(analysis));
	cache.set(sessionId, { data: analysis, mtime: Date.now() });
}

export async function deleteBehaviorAnalysis(sessionId: string): Promise<void> {
	cache.delete(sessionId);
	try {
		await unlink(behaviorPath(sessionId));
	} catch {
		// Already deleted
	}
}
