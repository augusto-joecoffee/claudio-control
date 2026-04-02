import { execFile } from "child_process";
import { promisify } from "util";
import { GIT_TIMEOUT_MS } from "./constants";

const execFileAsync = promisify(execFile);

async function gitCommand(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
		});
		return stdout.trim();
	} catch {
		return "";
	}
}

export async function getMergeBase(cwd: string, baseBranch: string): Promise<string> {
	return gitCommand(["merge-base", "HEAD", baseBranch], cwd);
}

export async function getDefaultBranch(cwd: string): Promise<string> {
	// Try symbolic-ref first (remote HEAD)
	const remoteHead = await gitCommand(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (remoteHead) {
		// Returns e.g. "refs/remotes/origin/main"
		const parts = remoteHead.split("/");
		return parts[parts.length - 1];
	}
	// Fallback: check if "main" or "master" exists
	const mainExists = await gitCommand(["rev-parse", "--verify", "main"], cwd);
	if (mainExists) return "main";
	const masterExists = await gitCommand(["rev-parse", "--verify", "master"], cwd);
	if (masterExists) return "master";
	return "main";
}

/**
 * Get the full unified diff between merge-base and HEAD, including working tree changes.
 * Returns raw unified diff text for react-diff-view's parseDiff().
 */
export async function getFullDiff(cwd: string, mergeBase: string): Promise<string> {
	// Committed changes since merge-base
	const committedDiff = await gitCommand(["diff", `${mergeBase}..HEAD`, "--unified=5"], cwd);

	// Uncommitted changes (staged + unstaged)
	const workingDiff = await gitCommand(["diff", "HEAD", "--unified=5"], cwd);

	// For untracked new files, generate diff manually
	const untrackedRaw = await gitCommand(["ls-files", "--others", "--exclude-standard"], cwd);
	const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);

	const untrackedDiffs: string[] = [];
	for (const file of untrackedFiles) {
		const content = await gitCommand(["hash-object", "--stdin", "--path", file], cwd);
		if (content) {
			// Read the file content to generate a proper diff
			try {
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", "/dev/null", file], {
					cwd,
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				});
				if (stdout) untrackedDiffs.push(stdout.trim());
			} catch (e: unknown) {
				// git diff --no-index exits with code 1 when files differ (which they always will)
				const err = e as { stdout?: string };
				if (err.stdout) untrackedDiffs.push(err.stdout.trim());
			}
		}
	}

	const parts = [committedDiff, workingDiff, ...untrackedDiffs].filter(Boolean);
	return parts.join("\n");
}

/**
 * Get a compact stat summary for the file tree sidebar.
 */
export async function getDiffStat(cwd: string, mergeBase: string): Promise<string> {
	const committedStat = await gitCommand(["diff", `${mergeBase}..HEAD`, "--stat"], cwd);
	const workingStat = await gitCommand(["diff", "HEAD", "--stat"], cwd);
	const parts = [committedStat, workingStat].filter(Boolean);
	return parts.join("\n");
}
