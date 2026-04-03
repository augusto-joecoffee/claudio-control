import { execFile } from "child_process";
import { promisify } from "util";
import { GIT_TIMEOUT_MS } from "./constants";
import { GitSummary } from "./types";

const execFileAsync = promisify(execFile);

async function gitCommand(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  const branch = await gitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch || null;
}

// TTL cache for git summary — git status doesn't change meaningfully every 2s
const gitSummaryCache = new Map<string, { result: GitSummary | null; ts: number }>();
const GIT_SUMMARY_TTL_MS = 10_000;

export async function getGitSummary(cwd: string): Promise<GitSummary | null> {
  const now = Date.now();
  const cached = gitSummaryCache.get(cwd);
  if (cached && now - cached.ts < GIT_SUMMARY_TTL_MS) {
    return cached.result;
  }

  const [branch, porcelain, shortStat] = await Promise.all([
    gitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    gitCommand(["status", "--porcelain"], cwd),
    gitCommand(["diff", "--shortstat"], cwd),
  ]);

  if (!branch) {
    gitSummaryCache.set(cwd, { result: null, ts: now });
    return null;
  }

  const lines = porcelain.split("\n").filter(Boolean);
  const untrackedFiles = lines.filter((l) => l.startsWith("??")).length;
  const changedFiles = lines.filter((l) => !l.startsWith("??")).length;

  let additions = 0;
  let deletions = 0;
  const statMatch = shortStat.match(/(\d+) insertion/);
  const delMatch = shortStat.match(/(\d+) deletion/);
  if (statMatch) additions = parseInt(statMatch[1], 10);
  if (delMatch) deletions = parseInt(delMatch[1], 10);

  const result: GitSummary = {
    branch,
    changedFiles,
    additions,
    deletions,
    untrackedFiles,
    shortStat: shortStat || "clean",
  };
  gitSummaryCache.set(cwd, { result, ts: now });
  return result;
}

export async function getGitDiff(cwd: string): Promise<string | null> {
  const diff = await gitCommand(["diff", "--stat"], cwd);
  return diff || null;
}

// Cache: branch → { url, timestamp }
const prUrlCache = new Map<string, { url: string | null; ts: number }>();
const PR_URL_TTL_MS = 60_000; // 60s for known PR URLs
const PR_URL_NULL_TTL_MS = 30_000; // 30s for "no PR" results

export async function getPrUrl(cwd: string, branch: string): Promise<string | null> {
  const cacheKey = `${cwd}::${branch}`;
  const now = Date.now();
  for (const [key, entry] of prUrlCache) {
    const ttl = entry.url ? PR_URL_TTL_MS : PR_URL_NULL_TTL_MS;
    if (now - entry.ts >= ttl) prUrlCache.delete(key);
  }

  const cached = prUrlCache.get(cacheKey);
  if (cached) return cached.url;

  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
      cwd,
      timeout: 5000,
    });
    const url = stdout.trim() || null;
    prUrlCache.set(cacheKey, { url, ts: Date.now() });
    return url;
  } catch {
    prUrlCache.set(cacheKey, { url: null, ts: Date.now() });
    return null;
  }
}

// TTL cache for worktree path — essentially static
const worktreeCache = new Map<string, { result: string | null; ts: number }>();
const WORKTREE_TTL_MS = 60_000;

export async function getMainWorktreePath(cwd: string): Promise<string | null> {
  const now = Date.now();
  const cached = worktreeCache.get(cwd);
  if (cached && now - cached.ts < WORKTREE_TTL_MS) {
    return cached.result;
  }

  const output = await gitCommand(["worktree", "list", "--porcelain"], cwd);
  if (!output) {
    // Don't cache failures — retry on next poll
    return null;
  }
  // First "worktree" line is always the main worktree
  const match = output.match(/^worktree (.+)$/m);
  const result = match ? match[1] : null;
  worktreeCache.set(cwd, { result, ts: now });
  return result;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
}

/**
 * List all worktrees by reading the filesystem directly — no git process.
 * Reads .git/worktrees/<name>/gitdir for each worktree path,
 * and .git/worktrees/<name>/HEAD for the branch.
 */
export async function getAllWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { readdir, readFile, stat: fsStat } = await import("fs/promises");
  const { join, dirname } = await import("path");

  // Find the .git directory (cwd might be a worktree itself)
  let gitDir: string;
  const dotGit = join(cwd, ".git");
  try {
    const s = await fsStat(dotGit);
    if (s.isDirectory()) {
      gitDir = dotGit;
    } else {
      // .git is a file → this is a worktree, read the real gitdir
      const content = (await readFile(dotGit, "utf-8")).trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return [];
      // The gitdir points to .git/worktrees/<name> in the main repo
      const worktreeGitDir = match[1].startsWith("/") ? match[1] : join(cwd, match[1]);
      // Go up two levels: .git/worktrees/<name> → .git
      gitDir = dirname(dirname(worktreeGitDir));
    }
  } catch {
    return [];
  }

  // The main repo is the parent of .git
  const mainRepoPath = dirname(gitDir);

  // Read the main repo's branch from .git/HEAD
  let mainBranch: string | null = null;
  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf-8")).trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    mainBranch = m ? m[1] : null;
  } catch { /* detached HEAD or missing */ }

  const worktrees: WorktreeInfo[] = [
    { path: mainRepoPath, branch: mainBranch, isMain: true },
  ];

  // Read .git/worktrees/ for non-main worktrees
  const worktreesDir = join(gitDir, "worktrees");
  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return worktrees; // No worktrees directory — just the main repo
  }

  await Promise.all(entries.map(async (name) => {
    const wtDir = join(worktreesDir, name);
    try {
      const s = await fsStat(wtDir);
      if (!s.isDirectory()) return;

      // Read gitdir file to get the worktree path
      const gitdirContent = (await readFile(join(wtDir, "gitdir"), "utf-8")).trim();
      // gitdir points to <worktree>/.git — parent is the worktree path
      const wtPath = dirname(gitdirContent);

      // Read HEAD for the branch
      let branch: string | null = null;
      try {
        const head = (await readFile(join(wtDir, "HEAD"), "utf-8")).trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        branch = m ? m[1] : null;
      } catch { /* detached HEAD */ }

      worktrees.push({ path: wtPath, branch, isMain: false });
    } catch { /* skip broken entries */ }
  }));

  return worktrees;
}
