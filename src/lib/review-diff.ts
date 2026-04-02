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

/**
 * Fast fingerprint of the current diff state.
 * Uses --stat (which relies on git's stat cache) + HEAD hash + untracked file list.
 * Changes whenever a file is committed, edited, staged, or added/removed.
 */
export async function getDiffFingerprint(cwd: string, mergeBase: string): Promise<string> {
	const [head, stat, untracked] = await Promise.all([
		gitCommand(["rev-parse", "HEAD"], cwd),
		gitCommand(["diff", mergeBase, "--stat"], cwd),
		gitCommand(["ls-files", "--others", "--exclude-standard"], cwd),
	]);
	const combined = `${head}\n${stat}\n${untracked}`;
	let h = 0;
	for (let i = 0; i < combined.length; i++) {
		h = ((h << 5) - h + combined.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}

export async function getMergeBase(cwd: string, baseBranch: string): Promise<string> {
	return gitCommand(["merge-base", "HEAD", baseBranch], cwd);
}

export async function getBranches(cwd: string): Promise<string[]> {
	const [local, remote] = await Promise.all([
		gitCommand(["branch", "--format=%(refname:short)"], cwd),
		gitCommand(["branch", "-r", "--format=%(refname:short)"], cwd),
	]);
	const branches = new Set<string>();
	for (const b of local.split("\n").filter(Boolean)) branches.add(b);
	for (const b of remote.split("\n").filter(Boolean)) {
		// "origin/main" → "main"
		const short = b.replace(/^[^/]+\//, "");
		if (short !== "HEAD") branches.add(short);
	}
	return Array.from(branches).sort();
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
 * Get the full unified diff between merge-base and the working tree.
 * Uses a single `git diff mergeBase` so each file appears once with a clean diff.
 * Returns raw unified diff text for react-diff-view's parseDiff().
 */
export async function getFullDiff(cwd: string, mergeBase: string): Promise<string> {
	// git diff <mergeBase> (no ..HEAD) diffs merge-base directly against the working tree,
	// producing a single clean diff per file that includes both committed and uncommitted changes.
	const [fullDiff, untrackedRaw] = await Promise.all([
		gitCommand(["diff", mergeBase, "--unified=5"], cwd),
		gitCommand(["ls-files", "--others", "--exclude-standard"], cwd),
	]);

	const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);

	// Batch all untracked file diffs in parallel
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

	const parts = [fullDiff, ...untrackedDiffs].filter(Boolean);
	return parts.join("\n");
}

/**
 * Get the list of files that have uncommitted changes (staged, unstaged, or untracked).
 */
export async function getUncommittedFiles(cwd: string): Promise<string[]> {
	const [changedRaw, untrackedRaw] = await Promise.all([
		gitCommand(["diff", "HEAD", "--name-only"], cwd),
		gitCommand(["ls-files", "--others", "--exclude-standard"], cwd),
	]);
	const files = new Set<string>();
	for (const f of changedRaw.split("\n").filter(Boolean)) files.add(f);
	for (const f of untrackedRaw.split("\n").filter(Boolean)) files.add(f);
	return Array.from(files);
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
	return gitCommand(["diff", mergeBase, "--stat"], cwd);
}
