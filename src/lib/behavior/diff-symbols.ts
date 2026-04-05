/**
 * Parse a unified diff to extract changed file ranges and identify
 * which symbols (functions, classes, methods) were modified.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { ChangedSymbol, FileLocation } from "../types";
import { SYMBOL_DECLARATION_PATTERNS, SYMBOL_SKIP_LIST, ANALYZABLE_EXTENSIONS } from "./patterns";
import { symbolConfidence } from "./confidence";

export interface ChangedRange {
	start: number;
	end: number;
}

export interface DiffFileInfo {
	filePath: string;
	changedRanges: ChangedRange[];
	isNew: boolean;
	isDeleted: boolean;
}

/**
 * Parse unified diff text into per-file changed line ranges (NEW side).
 */
export function parseDiffRanges(rawDiff: string): DiffFileInfo[] {
	const files: DiffFileInfo[] = [];
	// Split on diff headers
	const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

	for (const section of fileSections) {
		const lines = section.split("\n");

		// Extract file path from +++ line
		let filePath = "";
		let isNew = false;
		let isDeleted = false;

		for (const line of lines) {
			if (line.startsWith("+++ ")) {
				const path = line.slice(4).trim();
				if (path === "/dev/null") {
					isDeleted = true;
				} else {
					// Strip "b/" prefix
					filePath = path.replace(/^b\//, "");
				}
			} else if (line.startsWith("--- ")) {
				const path = line.slice(4).trim();
				if (path === "/dev/null") {
					isNew = true;
				} else if (!filePath) {
					// Fallback: use old path if new path is /dev/null
					filePath = path.replace(/^a\//, "");
				}
			}
		}

		if (!filePath && isDeleted) {
			// Deleted file — extract from --- line
			for (const line of lines) {
				if (line.startsWith("--- ") && !line.includes("/dev/null")) {
					filePath = line.slice(4).trim().replace(/^a\//, "");
					break;
				}
			}
		}

		if (!filePath) continue;

		// Parse hunk headers for changed ranges on the NEW side
		const changedRanges: ChangedRange[] = [];
		let currentNewLine = 0;

		for (const line of lines) {
			const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
			if (hunkMatch) {
				currentNewLine = parseInt(hunkMatch[1], 10);
				continue;
			}

			if (currentNewLine === 0) continue;

			if (line.startsWith("+") && !line.startsWith("+++")) {
				// This is an added/changed line
				const lineNum = currentNewLine;
				// Extend the last range or start a new one
				const lastRange = changedRanges[changedRanges.length - 1];
				if (lastRange && lastRange.end === lineNum - 1) {
					lastRange.end = lineNum;
				} else {
					changedRanges.push({ start: lineNum, end: lineNum });
				}
				currentNewLine++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				// Deleted line — does NOT advance new-side line counter
			} else if (line.startsWith("\\")) {
				// "\ No newline at end of file" — skip
			} else {
				// Context line — advances new-side counter
				currentNewLine++;
			}
		}

		files.push({ filePath, changedRanges, isNew, isDeleted });
	}

	return files;
}

/**
 * Find the end of a symbol's body using simple brace counting.
 * Returns the line number of the closing brace (1-based).
 */
function findSymbolEnd(fileLines: string[], declarationLine: number): number {
	let braceDepth = 0;
	let foundOpenBrace = false;

	for (let i = declarationLine - 1; i < fileLines.length; i++) {
		const line = fileLines[i];
		for (const ch of line) {
			if (ch === "{") {
				braceDepth++;
				foundOpenBrace = true;
			} else if (ch === "}") {
				braceDepth--;
				if (foundOpenBrace && braceDepth === 0) {
					return i + 1; // 1-based
				}
			}
		}
	}

	// Fallback: if no braces found (arrow function without braces, etc.)
	// assume symbol is just the declaration line + a few lines
	return Math.min(declarationLine + 10, fileLines.length);
}

/** Check if a file looks like a migration or schema definition (not business logic). */
function isSchemaMigrationFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return (
		/\bmigration/.test(lower) ||
		/\bschema\b/.test(lower) ||
		/\bentit(y|ies)\b/.test(lower) ||
		/\.entity\.(ts|js)$/.test(lower) ||
		/\.schema\.(ts|js)$/.test(lower) ||
		/\.migration\.(ts|js)$/.test(lower)
	);
}

/**
 * Extract changed symbols from source files based on diff ranges.
 */
export async function extractChangedSymbols(
	rawDiff: string,
	cwd: string,
): Promise<{
	symbols: ChangedSymbol[];
	diffFiles: DiffFileInfo[];
	fileContents: Map<string, string>;
	fileLines: Map<string, string[]>;
}> {
	const diffFiles = parseDiffRanges(rawDiff);
	const symbols: ChangedSymbol[] = [];
	const fileContents = new Map<string, string>();
	const fileLines = new Map<string, string[]>();

	// Filter to analyzable files
	const analyzableFiles = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return ANALYZABLE_EXTENSIONS.has(ext);
	});

	// Read all files in parallel (capped at 50)
	const filesToRead = analyzableFiles.slice(0, 50);
	const readResults = await Promise.all(
		filesToRead.map(async (f) => {
			try {
				const content = await readFile(join(cwd, f.filePath), "utf-8");
				return { filePath: f.filePath, content };
			} catch {
				return { filePath: f.filePath, content: null };
			}
		}),
	);

	for (const { filePath, content } of readResults) {
		if (content === null) continue;
		fileContents.set(filePath, content);
		fileLines.set(filePath, content.split("\n"));
	}

	// For each file, scan for symbol declarations and check overlap with changed ranges
	for (const diffFile of filesToRead) {
		const lines = fileLines.get(diffFile.filePath);
		if (!lines) continue;

		const isSchemaFile = isSchemaMigrationFile(diffFile.filePath);

		// Track which class we're currently inside (for qualified names and method scope)
		let currentClass: string | null = null;
		let classEndLine = 0;
		let classBraceDepth = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNumber = i + 1; // 1-based

			// Track class scope
			if (currentClass && lineNumber > classEndLine) {
				currentClass = null;
			}

			for (const pattern of SYMBOL_DECLARATION_PATTERNS) {
				// If pattern requires class scope and we're not in one, skip
				if (pattern.requiresClassScope && !currentClass) continue;

				const m = line.match(pattern.match);
				if (!m) continue;

				const name = m[pattern.nameGroup];
				if (!name) continue;

				// Skip names in the comprehensive skip list
				if (SYMBOL_SKIP_LIST.has(name)) continue;

				// In schema/entity files, only track exports (not methods/internal functions)
				if (isSchemaFile && !line.trimStart().startsWith("export")) continue;

				const symbolEndLine = findSymbolEnd(lines, lineNumber);
				const { confidence, isChanged } = symbolConfidence(lineNumber, symbolEndLine, diffFile.changedRanges);

				// Only include symbols that are changed or near changes
				if (confidence === "low" && !isChanged) continue;

				// Track class scope for qualified names
				if (pattern.kind === "class") {
					currentClass = name;
					classEndLine = symbolEndLine;
				}

				const qualifiedName = (pattern.kind === "method") && currentClass ? `${currentClass}.${name}` : name;

				const location: FileLocation = {
					filePath: diffFile.filePath,
					line: lineNumber,
					endLine: symbolEndLine,
					isChanged,
				};

				symbols.push({
					name,
					kind: pattern.kind,
					location,
					qualifiedName,
					confidence,
				});

				break; // First matching pattern wins for this line
			}
		}
	}

	return { symbols, diffFiles, fileContents, fileLines };
}
