import { readFile } from "fs/promises";
import { join } from "path";
import type { CodeSnippet } from "../types";

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
	html: "markup", htm: "markup", xml: "markup", svg: "markup",
	css: "css", scss: "css", less: "css",
	json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
	sh: "bash", bash: "bash", zsh: "bash",
	md: "markdown", mdx: "markdown",
	sql: "sql", graphql: "graphql", gql: "graphql",
	swift: "swift", dart: "dart", lua: "lua", r: "r",
};

function detectLanguage(filePath: string): string {
	const name = filePath.split("/").pop()?.toLowerCase() ?? "";
	if (name === "dockerfile") return "docker";
	if (name === "makefile") return "makefile";
	const ext = name.split(".").pop() ?? "";
	return EXT_TO_LANG[ext] ?? "text";
}

/**
 * Extract a code snippet from pre-loaded file lines.
 * Does NOT read from disk — uses the already-loaded lines.
 */
export function extractSnippetFromLines(
	fileLines: string[],
	filePath: string,
	centerLine: number,
	endLine?: number,
	contextLines: number = 5,
): CodeSnippet {
	const start = Math.max(1, centerLine - contextLines);
	const end = Math.min(fileLines.length, (endLine ?? centerLine) + contextLines);

	const content = fileLines.slice(start - 1, end).join("\n");

	return {
		filePath,
		startLine: start,
		endLine: end,
		content,
		language: detectLanguage(filePath),
	};
}

/**
 * Extract a code snippet by reading the file from disk.
 * Used when file content is not already in memory (e.g., for expand-context).
 */
export async function extractSnippetFromDisk(
	cwd: string,
	filePath: string,
	centerLine: number,
	endLine?: number,
	contextLines: number = 5,
): Promise<CodeSnippet> {
	try {
		const content = await readFile(join(cwd, filePath), "utf-8");
		const lines = content.split("\n");
		return extractSnippetFromLines(lines, filePath, centerLine, endLine, contextLines);
	} catch {
		return {
			filePath,
			startLine: centerLine,
			endLine: endLine ?? centerLine,
			content: "// File could not be read",
			language: detectLanguage(filePath),
		};
	}
}
