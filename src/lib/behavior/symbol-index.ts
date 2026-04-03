/**
 * Layer 2: Semantic Symbol Index
 *
 * Builds a whole-project symbol index with entrypoint classification
 * and side-effect metadata. This produces the SemanticCodeGraph (Graph 1).
 *
 * The graph covers ALL source files (not just changed ones) and is cached
 * per cwd with a 60-second TTL. On cache hit, only files that appear in the
 * current diff are refreshed from disk.
 */

import { Project, SyntaxKind, Node, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { join, resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import type { EntrypointKind, ConfidenceLevel } from "../types";
import type { SymbolNode, SymbolId, SemanticCodeGraph } from "./graph-types";
import { makeSymbolId, createEmptyGraph } from "./graph-types";
import { detectSideEffects } from "./side-effect-detector";
import { ANALYZABLE_EXTENSIONS } from "./patterns";

// ── Project + Graph Cache ──

let cache: {
	cwd: string;
	project: Project;
	graph: SemanticCodeGraph;
	createdAt: number;
} | null = null;

const CACHE_TTL = 60_000;

/**
 * Get or build the semantic code graph for a project.
 * Returns both the ts-morph Project and the SemanticCodeGraph.
 *
 * On cache hit: refreshes only the specified changed files.
 * On cache miss: loads the full project and indexes all source files.
 */
export function getProjectAndGraph(
	cwd: string,
	changedFilePaths?: string[],
): { project: Project; graph: SemanticCodeGraph } {
	const now = Date.now();

	if (cache && cache.cwd === cwd && now - cache.createdAt < CACHE_TTL) {
		// Cache hit — refresh only changed files
		if (changedFilePaths) {
			for (const relPath of changedFilePaths) {
				const absPath = resolve(cwd, relPath);
				const existing = cache.project.getSourceFile(absPath);
				if (existing) {
					existing.refreshFromFileSystemSync();
					// Re-index this file's symbols
					reindexFile(existing, relPath, cache.graph);
				} else {
					try {
						const sf = cache.project.addSourceFileAtPath(absPath);
						indexFile(sf, relPath, cache.graph);
					} catch { /* file may not exist */ }
				}
			}
		}
		return { project: cache.project, graph: cache.graph };
	}

	// Cache miss — build from scratch
	const project = loadProject(cwd, changedFilePaths);
	const graph = buildFullGraph(project, cwd);

	cache = { cwd, project, graph, createdAt: now };
	return { project, graph };
}

/** Invalidate all caches. */
export function invalidateGraphCache(): void {
	cache = null;
}

// ── Project Loading ──

function loadProject(cwd: string, changedFilePaths?: string[]): Project {
	const tsConfigPath = findTsConfig(cwd, changedFilePaths);

	if (tsConfigPath) {
		return new Project({
			tsConfigFilePath: tsConfigPath,
			skipAddingFilesFromTsConfig: false,
		});
	}

	// Fallback: create project without tsconfig
	const project = new Project({
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			esModuleInterop: true,
			allowJs: true,
			jsx: ts.JsxEmit.ReactJSX,
			strict: false,
			noEmit: true,
		},
	});
	project.addSourceFilesAtPaths(join(cwd, "src/**/*.{ts,tsx,js,jsx}"));
	return project;
}

/**
 * Find the best tsconfig for the project. Handles monorepos where the root
 * tsconfig may have `"files": []` and the actual sources are in a sub-package.
 *
 * Strategy:
 * 1. Check root tsconfig — if it includes files (no empty `files` array), use it
 * 2. If root is empty, look for tsconfig in common monorepo app directories
 * 3. Use changed file paths to determine which sub-package to target
 */
function findTsConfig(cwd: string, changedFilePaths?: string[]): string | undefined {
	// Try root tsconfig first
	const rootConfig = join(cwd, "tsconfig.json");
	if (existsSync(rootConfig)) {
		try {
			const content = JSON.parse(readFileSync(rootConfig, "utf-8"));
			// If root config has `files: []` or no include/files, it's a monorepo wrapper
			const hasFiles = content.files && content.files.length > 0;
			const hasInclude = content.include && content.include.length > 0;
			const hasReferences = content.references && content.references.length > 0;
			if (hasFiles || hasInclude) {
				return rootConfig; // Root config actually includes source files
			}
			// Root is a wrapper — find the sub-package tsconfig
		} catch { /* fall through */ }
	}

	// Determine sub-package from changed file paths
	if (changedFilePaths && changedFilePaths.length > 0) {
		// Extract common prefix directory (e.g., "apps/platform/src/..." → "apps/platform")
		const subDirs = new Set<string>();
		for (const p of changedFilePaths) {
			const parts = p.split("/");
			// Look for patterns like "apps/X", "packages/X", "services/X"
			if (parts.length >= 2) {
				if (["apps", "packages", "services", "libs"].includes(parts[0])) {
					subDirs.add(parts.slice(0, 2).join("/"));
				}
			}
		}

		for (const subDir of subDirs) {
			for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
				const p = join(cwd, subDir, name);
				if (existsSync(p)) return p;
			}
		}
	}

	// Fallback: search common monorepo structures
	for (const pattern of ["apps/*/tsconfig.json", "packages/*/tsconfig.json"]) {
		const dir = pattern.split("/").slice(0, -1).join("/");
		const base = join(cwd, dir);
		if (existsSync(base)) {
			try {
				const entries = readdirSync(base);
				for (const entry of entries) {
					const tsconfig = join(base, entry, "tsconfig.json");
					if (existsSync(tsconfig)) return tsconfig;
				}
			} catch { /* continue */ }
		}
	}

	// Last resort: root tsconfig even if it's a wrapper
	if (existsSync(rootConfig)) return rootConfig;

	// Try tsconfig.build.json
	const buildConfig = join(cwd, "tsconfig.build.json");
	if (existsSync(buildConfig)) return buildConfig;

	return undefined;
}

// ── Full Graph Build ──

function buildFullGraph(project: Project, cwd: string): SemanticCodeGraph {
	const graph = createEmptyGraph();

	for (const sourceFile of project.getSourceFiles()) {
		const absPath = sourceFile.getFilePath();
		// Skip node_modules and declaration files
		if (absPath.includes("/node_modules/") || absPath.endsWith(".d.ts")) continue;

		const relPath = makeRelative(absPath, cwd);
		if (relPath.startsWith("/")) continue; // outside project

		const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
		if (!ANALYZABLE_EXTENSIONS.has(ext)) continue;

		indexFile(sourceFile, relPath, graph);
	}

	return graph;
}

// ── File Indexing ──

/** Remove all nodes from a file and re-index it. */
function reindexFile(sourceFile: SourceFile, relPath: string, graph: SemanticCodeGraph): void {
	// Remove existing nodes for this file
	for (const [id, node] of graph.nodes) {
		if (node.filePath === relPath) {
			graph.nodes.delete(id);
		}
	}
	// Re-index
	indexFile(sourceFile, relPath, graph);
}

/**
 * Index all symbols from a single source file into the graph.
 * Extracts function/method/class declarations, classifies entrypoints,
 * and attaches side effects detected by the pattern-based detector.
 */
function indexFile(sourceFile: SourceFile, relPath: string, graph: SemanticCodeGraph): void {
	// Walk top-level declarations
	for (const decl of sourceFile.getStatements()) {
		if (Node.isFunctionDeclaration(decl) && decl.getName()) {
			addSymbolNode(graph, decl, decl.getName()!, "function", relPath, null);
		} else if (Node.isClassDeclaration(decl) && decl.getName()) {
			const className = decl.getName()!;
			addSymbolNode(graph, decl, className, "class", relPath, null);
			for (const method of decl.getMethods()) {
				addSymbolNode(graph, method, method.getName(), "method", relPath, className);
			}
		} else if (Node.isVariableStatement(decl)) {
			for (const varDecl of decl.getDeclarationList().getDeclarations()) {
				const init = varDecl.getInitializer();
				if (!init) continue;
				if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
					addSymbolNode(graph, varDecl, varDecl.getName(), "function", relPath, null);
				} else if (Node.isObjectLiteralExpression(init)) {
					addSymbolNode(graph, varDecl, varDecl.getName(), "export", relPath, null);
				}
			}
		} else if (Node.isExportAssignment(decl)) {
			const expr = decl.getExpression();
			if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
				addSymbolNode(graph, decl, "default", "function", relPath, null);
			}
		}
	}

	// Also find standalone function declarations (hoisted)
	for (const fn of sourceFile.getFunctions()) {
		if (!fn.getName()) continue;
		const id = makeSymbolId(relPath, fn.getName()!);
		if (graph.nodes.has(id)) continue; // already captured
		addSymbolNode(graph, fn, fn.getName()!, "function", relPath, null);
	}
}

function addSymbolNode(
	graph: SemanticCodeGraph,
	node: Node,
	name: string,
	kind: SymbolNode["kind"],
	filePath: string,
	className: string | null,
): void {
	const qualifiedName = className ? `${className}.${name}` : name;
	const id = makeSymbolId(filePath, qualifiedName);

	// Detect if exported
	const exported = isExported(node);

	// Classify entrypoint
	const entrypointKind = classifyEntrypoint(name, kind, filePath, node, exported);

	// Detect side effects in the symbol body
	const bodyText = node.getText();
	const bodyLines = bodyText.split("\n");
	const startLine = node.getStartLineNumber();
	const sideEffects = detectSideEffects(bodyLines, filePath, startLine);

	const symbolNode: SymbolNode = {
		id,
		name,
		qualifiedName,
		kind,
		filePath,
		line: startLine,
		endLine: node.getEndLineNumber(),
		node,
		isExported: exported,
		entrypointKind,
		sideEffects,
		confidence: "high", // AST-extracted, always high
	};

	graph.nodes.set(id, symbolNode);
}

// ── Entrypoint Classification ──

function classifyEntrypoint(
	name: string,
	kind: SymbolNode["kind"],
	filePath: string,
	node: Node,
	isExported: boolean,
): EntrypointKind | null {
	// Next.js App Router routes
	if (/\/app\/.*\/route\.(ts|js|tsx|jsx)$/.test(filePath) && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(name)) {
		return "api-route";
	}

	// Next.js Pages API
	if (/\/pages\/api\//.test(filePath) && (name === "default" || name === "handler")) {
		return "api-route";
	}

	// Job files
	if (/\.(job|worker)\.(ts|js)$/.test(filePath) || /\/jobs?\//.test(filePath)) {
		if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(name)) return "queue-consumer";
		if (isExported && kind === "function") return "queue-consumer";
	}

	// Cron files
	if (/\/crons?\//.test(filePath) || /\.cron\.(ts|js)$/.test(filePath)) {
		if (/^(perform|prePerform|postPerform|execute|run|handle)$/.test(name)) return "cron-job";
		if (isExported && kind === "function") return "cron-job";
	}

	// Test files
	if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(filePath) || /__tests__\//.test(filePath)) {
		if (kind === "function" && isExported) return "test-function";
	}

	// React component pages
	if (/\/app\/.*\/page\.(tsx|jsx)$/.test(filePath)) return "react-component";

	// Express/Koa routes
	if (isExported && kind === "function") {
		const text = node.getText();
		if (/\b(app|router)\.(get|post|put|delete|patch|use)\s*\(/.test(text)) return "api-route";
	}

	// Exported functions in service/controller/handler files
	if (isExported && kind === "function") {
		if (/\b(controller|handler|service|route|api|endpoint)\b/i.test(filePath)) return "exported-function";
	}

	return null;
}

function isExported(node: Node): boolean {
	if (Node.isExportable(node) && node.isExported()) return true;
	const parent = node.getParent();
	if (parent && Node.isVariableDeclarationList(parent)) {
		const varStmt = parent.getParent();
		if (varStmt && Node.isVariableStatement(varStmt)) return varStmt.isExported();
	}
	return false;
}

// ── Helpers ──

function makeRelative(absPath: string, cwd: string): string {
	const cwdNormalized = cwd.endsWith("/") ? cwd : cwd + "/";
	if (absPath.startsWith(cwdNormalized)) return absPath.slice(cwdNormalized.length);
	return absPath;
}
