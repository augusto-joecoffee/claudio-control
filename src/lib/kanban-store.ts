import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { KanbanConfig, KanbanState } from "./types";

const CONFIG_DIR = join(homedir(), ".claude-control");
const KANBAN_DIR = join(CONFIG_DIR, "kanban");

const EMPTY_CONFIG: KanbanConfig = { columns: [] };
const EMPTY_STATE: KanbanState = { placements: [], outputHistory: {} };

// ── In-memory caches with mtime tracking ──

const configCache = new Map<string, { data: KanbanConfig; mtime: number }>();
const stateCache = new Map<string, { data: KanbanState; mtime: number }>();

function configPath(repoId: string): string {
  return join(KANBAN_DIR, `${repoId}.json`);
}

function statePath(repoId: string): string {
  return join(KANBAN_DIR, `${repoId}.state.json`);
}

// ── Config (user-editable column definitions) ──

export async function loadKanbanConfig(repoId: string): Promise<KanbanConfig> {
  const file = configPath(repoId);
  try {
    const s = await stat(file);
    const cached = configCache.get(repoId);
    if (cached && cached.mtime === s.mtimeMs) return cached.data;

    const raw = await readFile(file, "utf-8");
    const data: KanbanConfig = { ...EMPTY_CONFIG, ...JSON.parse(raw) };
    configCache.set(repoId, { data, mtime: s.mtimeMs });
    return data;
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export async function saveKanbanConfig(repoId: string, config: KanbanConfig): Promise<void> {
  await mkdir(KANBAN_DIR, { recursive: true });
  const file = configPath(repoId);
  await writeFile(file, JSON.stringify(config, null, 2));
  const s = await stat(file);
  configCache.set(repoId, { data: config, mtime: s.mtimeMs });
}

// ── State (runtime placements and output history) ──

export async function loadKanbanState(repoId: string): Promise<KanbanState> {
  const file = statePath(repoId);
  try {
    const s = await stat(file);
    const cached = stateCache.get(repoId);
    if (cached && cached.mtime === s.mtimeMs) return cached.data;

    const raw = await readFile(file, "utf-8");
    const data: KanbanState = { ...EMPTY_STATE, ...JSON.parse(raw) };
    stateCache.set(repoId, { data, mtime: s.mtimeMs });
    return data;
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveKanbanState(repoId: string, state: KanbanState): Promise<void> {
  await mkdir(KANBAN_DIR, { recursive: true });
  const file = statePath(repoId);
  await writeFile(file, JSON.stringify(state, null, 2));
  const s = await stat(file);
  stateCache.set(repoId, { data: state, mtime: s.mtimeMs });
}

// ── Batch: load all configs ──

export async function getAllKanbanConfigs(): Promise<Map<string, KanbanConfig>> {
  const result = new Map<string, KanbanConfig>();
  try {
    const files = await readdir(KANBAN_DIR);
    for (const file of files) {
      if (file.endsWith(".state.json") || !file.endsWith(".json")) continue;
      const repoId = file.replace(/\.json$/, "");
      const config = await loadKanbanConfig(repoId);
      if (config.columns.length > 0) {
        result.set(repoId, config);
      }
    }
  } catch {
    // Directory doesn't exist yet — no configs
  }
  return result;
}
