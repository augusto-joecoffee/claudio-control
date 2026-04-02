import { execFile } from "child_process";
import { promisify } from "util";
import { GIT_TIMEOUT_MS } from "./constants";

const execFileAsync = promisify(execFile);

async function gitCommand(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout.trim();
	} catch {
		return "";
	}
}

export async function getMergeBase(cwd: string, baseBranch: string): Promise<string> {
	return gitCommand(["merge-base", "HEAD", baseBranch], cwd);
}

let defaultBranchCache: Map<string, string> | undefined;

export async function getDefaultBranch(cwd: string): Promise<string> {
	if (!defaultBranchCache) defaultBranchCache = new Map();
	const cached = defaultBranchCache.get(cwd);
	if (cached) return cached;

	const remoteHead = await gitCommand(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (remoteHead) {
		const branch = remoteHead.split("/").pop()!;
		defaultBranchCache.set(cwd, branch);
		return branch;
	}
	const mainExists = await gitCommand(["rev-parse", "--verify", "main"], cwd);
	if (mainExists) { defaultBranchCache.set(cwd, "main"); return "main"; }
	const masterExists = await gitCommand(["rev-parse", "--verify", "master"], cwd);
	if (masterExists) { defaultBranchCache.set(cwd, "master"); return "master"; }
	return "main";
}

/**
 * Get the full unified diff between merge-base and HEAD, including working tree changes.
 * Returns raw unified diff text for react-diff-view's parseDiff().
 */
export async function getFullDiff(cwd: string, mergeBase: string): Promise<string> {
	// Run all independent git commands in parallel
	const [committedDiff, workingDiff, untrackedRaw] = await Promise.all([
		gitCommand(["diff", `${mergeBase}..HEAD`, "--unified=5"], cwd),
		gitCommand(["diff", "HEAD", "--unified=5"], cwd),
		gitCommand(["ls-files", "--others", "--exclude-standard"], cwd),
	]);

	const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);

	// Batch all untracked file diffs in parallel instead of sequential
	const untrackedDiffs = await Promise.all(
		untrackedFiles.map(async (file) => {
			try {
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", "/dev/null", file], {
					cwd,
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				});
				return stdout.trim();
			} catch (e: unknown) {
				// git diff --no-index exits with code 1 when files differ (which they always will)
				const err = e as { stdout?: string };
				return err.stdout?.trim() ?? "";
			}
		}),
	);

	const parts = [committedDiff, workingDiff, ...untrackedDiffs].filter(Boolean);
	return parts.join("\n");
}

/**
 * Get all committed changes on the branch (merge-base..HEAD).
 */
export async function getBranchDiff(cwd: string, mergeBase: string): Promise<string> {
	return gitCommand(["diff", `${mergeBase}..HEAD`, "--unified=5"], cwd);
}

/**
 * Get only unpushed commits (upstream..HEAD).
 * Falls back to all branch commits if no upstream is set.
 */
export async function getCommittedDiff(cwd: string, mergeBase: string): Promise<string> {
	const upstream = await gitCommand(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
	const base = upstream || mergeBase;
	return gitCommand(["diff", `${base}..HEAD`, "--unified=5"], cwd);
}

/**
 * Get only uncommitted changes (staged + unstaged + untracked).
 */
export async function getUncommittedDiff(cwd: string): Promise<string> {
	const [workingDiff, untrackedRaw] = await Promise.all([
		gitCommand(["diff", "HEAD", "--unified=5"], cwd),
		gitCommand(["ls-files", "--others", "--exclude-standard"], cwd),
	]);

	const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);

	const untrackedDiffs = await Promise.all(
		untrackedFiles.map(async (file) => {
			try {
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", "/dev/null", file], {
					cwd,
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				});
				return stdout.trim();
			} catch (e: unknown) {
				const err = e as { stdout?: string };
				return err.stdout?.trim() ?? "";
			}
		}),
	);

	const parts = [workingDiff, ...untrackedDiffs].filter(Boolean);
	return parts.join("\n");
}

/**
 * Get the diff for a single commit.
 */
export async function getCommitDiff(cwd: string, commitHash: string): Promise<string> {
	return gitCommand(["diff", `${commitHash}~1..${commitHash}`, "--unified=5"], cwd);
}

/**
 * List commits between merge-base and HEAD.
 */
export async function getCommits(cwd: string, mergeBase: string): Promise<{ hash: string; shortHash: string; subject: string }[]> {
	const raw = await gitCommand(["log", `${mergeBase}..HEAD`, "--format=%H|%h|%s"], cwd);
	if (!raw) return [];
	return raw.split("\n").map((line) => {
		const [hash, shortHash, ...rest] = line.split("|");
		return { hash, shortHash, subject: rest.join("|") };
	});
}

/**
 * Get a compact stat summary for the file tree sidebar.
 */
export async function getDiffStat(cwd: string, mergeBase: string): Promise<string> {
	const [committedStat, workingStat] = await Promise.all([
		gitCommand(["diff", `${mergeBase}..HEAD`, "--stat"], cwd),
		gitCommand(["diff", "HEAD", "--stat"], cwd),
	]);
	const parts = [committedStat, workingStat].filter(Boolean);
	return parts.join("\n");
}
