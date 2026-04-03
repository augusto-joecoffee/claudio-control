/**
 * Build an approximate call graph by scanning function bodies for calls
 * to other known symbols. Regex-based — explicitly heuristic.
 */

import { readFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import type { ChangedSymbol } from "../types";

interface ImportEntry {
	localName: string;
	sourcePath: string; // Resolved relative to cwd
}

/** Parse import statements from a source file and resolve paths. */
function parseImports(fileContent: string, filePath: string, cwd: string): ImportEntry[] {
	const imports: ImportEntry[] = [];
	const dir = dirname(filePath);

	// Match: import { a, b } from './path'
	const namedImportRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = namedImportRe.exec(fileContent)) !== null) {
		const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
		const source = m[2];
		if (source.startsWith(".")) {
			const resolved = resolveImportPath(dir, source);
			for (const name of names) {
				imports.push({ localName: name, sourcePath: resolved });
			}
		}
	}

	// Match: import foo from './path'
	const defaultImportRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
	while ((m = defaultImportRe.exec(fileContent)) !== null) {
		const name = m[1];
		const source = m[2];
		if (source.startsWith(".")) {
			imports.push({ localName: name, sourcePath: resolveImportPath(dir, source) });
		}
	}

	return imports;
}

/** Resolve a relative import path, stripping extension. */
function resolveImportPath(fromDir: string, importPath: string): string {
	const resolved = resolve(fromDir, importPath);
	// Strip extension for matching — we'll match against filePath sans-extension
	return resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/** Strip extension from a file path for matching. */
function stripExt(filePath: string): string {
	return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/**
 * Build an approximate call graph from changed symbols.
 *
 * Returns an adjacency list: Map<qualifiedName, qualifiedName[]>
 * and a list of warnings about what couldn't be resolved.
 */
export async function buildCallGraph(
	allSymbols: ChangedSymbol[],
	fileContents: Map<string, string>,
	fileLines: Map<string, string[]>,
	cwd: string,
): Promise<{
	graph: Map<string, string[]>;
	warnings: string[];
}> {
	const graph = new Map<string, string[]>();
	const warnings: string[] = [];

	// Build a lookup: symbolName → ChangedSymbol[] (there can be duplicates across files)
	const symbolsByName = new Map<string, ChangedSymbol[]>();
	const symbolsByQualified = new Map<string, ChangedSymbol>();

	for (const sym of allSymbols) {
		const key = sym.qualifiedName ?? sym.name;
		symbolsByQualified.set(key, sym);

		const existing = symbolsByName.get(sym.name) ?? [];
		existing.push(sym);
		symbolsByName.set(sym.name, existing);
	}

	// For each file, build import maps
	const importsByFile = new Map<string, ImportEntry[]>();
	for (const [filePath, content] of fileContents) {
		importsByFile.set(filePath, parseImports(content, filePath, cwd));
	}

	// For each symbol, scan its body for calls to other symbols
	for (const symbol of allSymbols) {
		const lines = fileLines.get(symbol.location.filePath);
		if (!lines) continue;

		const startIdx = symbol.location.line - 1; // 0-based
		const endIdx = Math.min((symbol.location.endLine ?? symbol.location.line + 10) - 1, lines.length);
		const body = lines.slice(startIdx, endIdx).join("\n");

		const callerKey = symbol.qualifiedName ?? symbol.name;
		const callees: string[] = [];

		// Check for calls to other symbols
		for (const [name, candidates] of symbolsByName) {
			if (name === symbol.name && candidates.length === 1 && candidates[0] === symbol) continue; // Skip self

			// Check if the body contains this symbol name as a function call or reference
			// Use word boundary to avoid partial matches
			const callRegex = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, "g");
			if (!callRegex.test(body)) continue;

			// Determine which candidate this call targets
			const target = resolveCallTarget(
				name,
				candidates,
				symbol.location.filePath,
				importsByFile.get(symbol.location.filePath) ?? [],
				cwd,
			);

			if (target) {
				const targetKey = target.qualifiedName ?? target.name;
				if (targetKey !== callerKey) {
					callees.push(targetKey);
				}
			}
		}

		if (callees.length > 0) {
			graph.set(callerKey, callees);
		}
	}

	return { graph, warnings };
}

/** Resolve which symbol a call targets based on imports and file proximity. */
function resolveCallTarget(
	name: string,
	candidates: ChangedSymbol[],
	callerFile: string,
	imports: ImportEntry[],
	cwd: string,
): ChangedSymbol | null {
	// 1. Same-file candidate
	const sameFile = candidates.find((c) => c.location.filePath === callerFile);
	if (sameFile) return sameFile;

	// 2. Imported candidate
	const importEntry = imports.find((imp) => imp.localName === name);
	if (importEntry) {
		const target = candidates.find((c) => {
			const candidatePath = stripExt(c.location.filePath);
			// Check if import resolves to this file (handle index files too)
			return (
				importEntry.sourcePath === candidatePath ||
				importEntry.sourcePath === candidatePath + "/index" ||
				importEntry.sourcePath.endsWith("/" + candidatePath)
			);
		});
		if (target) return target;
	}

	// 3. If only one candidate, use it (low confidence)
	if (candidates.length === 1) return candidates[0];

	return null;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
