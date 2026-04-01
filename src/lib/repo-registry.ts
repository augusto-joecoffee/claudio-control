import { randomBytes } from "crypto";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".claude-control");
const REGISTRY_PATH = join(CONFIG_DIR, "repo-registry.json");
const KANBAN_DIR = join(CONFIG_DIR, "kanban");

export interface RepoEntry {
  id: string;
  repoPath: string;
  displayName: string;
  createdAt: string;
}

// ── In-memory cache with mtime tracking ──

let cache: { entries: RepoEntry[]; mtime: number } | null = null;

async function loadRegistry(): Promise<RepoEntry[]> {
  try {
    const s = await stat(REGISTRY_PATH);
    if (cache && cache.mtime === s.mtimeMs) return cache.entries;
    const raw = await readFile(REGISTRY_PATH, "utf-8");
    const entries: RepoEntry[] = JSON.parse(raw);
    cache = { entries, mtime: s.mtimeMs };
    return entries;
  } catch {
    return [];
  }
}

async function saveRegistry(entries: RepoEntry[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(entries, null, 2));
  const s = await stat(REGISTRY_PATH);
  cache = { entries, mtime: s.mtimeMs };
}

function generateId(): string {
  return randomBytes(4).toString("hex"); // 8-char hex
}

/**
 * Look up or create a stable repo ID for the given canonical repo path.
 * If the repo is new, attempts to migrate existing kanban config files
 * that match the display name.
 */
export async function resolveRepoId(repoPath: string): Promise<string> {
  const entries = await loadRegistry();
  const existing = entries.find((e) => e.repoPath === repoPath);
  if (existing) return existing.id;

  // New repo — generate an ID
  let id = generateId();
  while (entries.some((e) => e.id === id)) {
    id = generateId();
  }

  const displayName = repoPath.split("/").filter(Boolean).pop() || repoPath;
  const entry: RepoEntry = { id, repoPath, displayName, createdAt: new Date().toISOString() };
  entries.push(entry);
  await saveRegistry(entries);

  // Migrate existing kanban files if they match the display name and no other repo claimed them
  await migrateKanbanFiles(displayName, id);

  return id;
}

/**
 * Resolve repo IDs for multiple paths in one call (batched for efficiency).
 * Returns a map of repoPath → repoId.
 */
export async function resolveRepoIds(repoPaths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await loadRegistry();
  const toCreate: string[] = [];

  for (const repoPath of repoPaths) {
    const existing = entries.find((e) => e.repoPath === repoPath);
    if (existing) {
      result[repoPath] = existing.id;
    } else {
      toCreate.push(repoPath);
    }
  }

  if (toCreate.length > 0) {
    for (const repoPath of toCreate) {
      let id = generateId();
      while (entries.some((e) => e.id === id)) {
        id = generateId();
      }
      const displayName = repoPath.split("/").filter(Boolean).pop() || repoPath;
      entries.push({ id, repoPath, displayName, createdAt: new Date().toISOString() });
      result[repoPath] = id;

      await migrateKanbanFiles(displayName, id);
    }
    await saveRegistry(entries);
  }

  return result;
}

export async function getRepoEntry(repoId: string): Promise<RepoEntry | undefined> {
  const entries = await loadRegistry();
  return entries.find((e) => e.id === repoId);
}

export async function getAllRepoEntries(): Promise<RepoEntry[]> {
  return loadRegistry();
}

/**
 * Migrate old kanban config files from {displayName}.json to {repoId}.json.
 * Only migrates if the old file exists and the new file doesn't.
 */
async function migrateKanbanFiles(displayName: string, repoId: string): Promise<void> {
  try {
    const oldConfig = join(KANBAN_DIR, `${displayName}.json`);
    const newConfig = join(KANBAN_DIR, `${repoId}.json`);
    const oldState = join(KANBAN_DIR, `${displayName}.state.json`);
    const newState = join(KANBAN_DIR, `${repoId}.state.json`);

    // Only migrate if old exists and new doesn't
    try {
      await stat(newConfig);
      return; // New file already exists — skip
    } catch {
      // New file doesn't exist — proceed
    }

    try {
      await stat(oldConfig);
      await rename(oldConfig, newConfig);
      console.log(`[repo-registry] Migrated kanban config: ${displayName}.json → ${repoId}.json`);
    } catch {
      // Old file doesn't exist — nothing to migrate
    }

    try {
      await stat(oldState);
      await rename(oldState, newState);
      console.log(`[repo-registry] Migrated kanban state: ${displayName}.state.json → ${repoId}.state.json`);
    } catch {
      // Old state doesn't exist — nothing to migrate
    }
  } catch (err) {
    console.error("[repo-registry] Migration error:", err);
  }
}
