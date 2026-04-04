import type { ChangeData } from "react-diff-view";

export interface FoldRegion {
	startLine: number; // new-side line number where fold starts
	endLine: number;   // new-side line number where fold ends
	label: string;     // truncated opening line, e.g. "function foo() {"
}

const MIN_FOLD_LINES = 4;

// Languages that use { } for blocks
const BRACKET_LANGUAGES = new Set([
	"typescript", "javascript", "java", "go", "rust", "c", "cpp", "csharp",
	"kotlin", "swift", "dart", "css", "json", "graphql", "bash", "lua",
]);

// Languages that use indentation for blocks
const INDENT_LANGUAGES = new Set(["python", "yaml"]);

/** Get the new-side line number for a change, or null for delete-only lines. */
function newLine(change: ChangeData): number | null {
	if (change.type === "normal") return change.newLineNumber ?? null;
	if (change.type === "insert") return change.lineNumber ?? null;
	return null; // delete
}

/** Heuristic: check if a brace is likely inside a string or comment. */
function braceIsInStringOrComment(content: string, braceIndex: number): boolean {
	const before = content.slice(0, braceIndex);
	// Skip if preceded by // comment
	if (/\/\//.test(before)) return true;
	// Skip if inside /* ... (no closing */)
	const lastOpen = before.lastIndexOf("/*");
	const lastClose = before.lastIndexOf("*/");
	if (lastOpen > lastClose) return true;
	// Count unescaped quotes before the brace — odd count means inside a string
	let singleQuotes = 0;
	let doubleQuotes = 0;
	let backticks = 0;
	for (let i = 0; i < braceIndex; i++) {
		if (content[i] === "\\" ) { i++; continue; }
		if (content[i] === "'") singleQuotes++;
		if (content[i] === '"') doubleQuotes++;
		if (content[i] === "`") backticks++;
	}
	if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) return true;
	return false;
}

/** Detect fold regions using bracket matching for C-like languages. */
function detectBracketFolds(changes: ChangeData[]): FoldRegion[] {
	const regions: FoldRegion[] = [];
	const stack: Array<{ line: number; label: string }> = [];

	for (const change of changes) {
		const ln = newLine(change);
		if (ln === null) continue;
		const content = change.content;

		// Find all { and } in the line, skipping those in strings/comments
		for (let i = 0; i < content.length; i++) {
			if (content[i] === "{" && !braceIsInStringOrComment(content, i)) {
				const label = content.trim().slice(0, 80);
				stack.push({ line: ln, label });
			} else if (content[i] === "}" && !braceIsInStringOrComment(content, i)) {
				const open = stack.pop();
				if (open && ln - open.line + 1 >= MIN_FOLD_LINES) {
					regions.push({ startLine: open.line, endLine: ln, label: open.label });
				}
			}
		}
	}

	return regions.sort((a, b) => a.startLine - b.startLine);
}

/** Detect fold regions using indentation for Python/YAML. */
function detectIndentFolds(changes: ChangeData[]): FoldRegion[] {
	const regions: FoldRegion[] = [];
	// Build an array of (line, indentation, content) for new-side lines only
	const lines: Array<{ line: number; indent: number; content: string }> = [];
	for (const change of changes) {
		const ln = newLine(change);
		if (ln === null) continue;
		const content = change.content;
		const stripped = content.replace(/^\t+/, (m: string) => "    ".repeat(m.length)); // normalize tabs
		const indent = stripped.search(/\S/);
		lines.push({ line: ln, indent: indent < 0 ? 0 : indent, content: content.trimEnd() });
	}

	for (let i = 0; i < lines.length - 1; i++) {
		const curr = lines[i];
		const next = lines[i + 1];
		// A block starts at a line ending with `:` followed by deeper indentation
		if (curr.content.endsWith(":") && next.indent > curr.indent) {
			// Find where indentation returns to curr level or less
			let endIdx = i + 1;
			for (let j = i + 2; j < lines.length; j++) {
				if (lines[j].indent <= curr.indent && lines[j].content.trim() !== "") {
					break;
				}
				endIdx = j;
			}
			const span = lines[endIdx].line - curr.line + 1;
			if (span >= MIN_FOLD_LINES) {
				regions.push({
					startLine: curr.line,
					endLine: lines[endIdx].line,
					label: curr.content.trim().slice(0, 80),
				});
			}
		}
	}

	return regions.sort((a, b) => a.startLine - b.startLine);
}

/** Detect foldable regions from the changes visible in the diff. */
export function detectFoldRegions(changes: ChangeData[], language: string | null): FoldRegion[] {
	if (!language || changes.length === 0) return [];
	if (BRACKET_LANGUAGES.has(language)) return detectBracketFolds(changes);
	if (INDENT_LANGUAGES.has(language)) return detectIndentFolds(changes);
	// Fallback: try bracket detection for unknown languages
	return detectBracketFolds(changes);
}
