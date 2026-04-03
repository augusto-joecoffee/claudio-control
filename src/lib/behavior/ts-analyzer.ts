/**
 * TypeScript-compiler-backed code analysis using ts-morph.
 *
 * Replaces the regex-based symbol extraction, entrypoint detection, and call
 * graph building with real type-checked AST analysis. Uses the same TypeScript
 * compiler that powers VS Code's Call Hierarchy.
 */

import { Project, SyntaxKind, Node, ts } from "ts-morph";
import type { SourceFile, FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression, VariableDeclaration, ClassDeclaration, CallExpression } from "ts-morph";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type {
	BehaviorAnalysis, ChangedBehavior, ChangedSymbol, ExecutionStep,
	SideEffect, CodeSnippet, FileLocation, EntrypointKind, ConfidenceLevel,
} from "../types";
import type { DiffFileInfo, ChangedRange } from "./diff-symbols";
import { parseDiffRanges } from "./diff-symbols";
import { detectSideEffects } from "./side-effect-detector";
import { ANALYZABLE_EXTENSIONS } from "./patterns";

// ── Types ──

interface AnalyzedSymbol {
	name: string;
	qualifiedName: string;
	kind: ChangedSymbol["kind"];
	filePath: string; // relative to cwd
	line: number;
	endLine: number;
	isChanged: boolean;
	confidence: ConfidenceLevel;
	/** The ts-morph Node for this symbol (not serialized). */
	node: Node;
}

interface AnalyzedEntrypoint {
	symbol: AnalyzedSymbol;
	kind: EntrypointKind;
	confidence: ConfidenceLevel;
}

// ── Project Cache ──
// Cache the ts-morph Project per cwd to avoid re-parsing on every request.
let cachedProject: { cwd: string; project: Project; createdAt: number } | null = null;
const PROJECT_CACHE_TTL = 60_000; // 60 seconds

function getOrCreateProject(cwd: string): Project {
	const now = Date.now();
	if (cachedProject && cachedProject.cwd === cwd && now - cachedProject.createdAt < PROJECT_CACHE_TTL) {
		return cachedProject.project;
	}

	const tsConfigPath = findTsConfig(cwd);
	let project: Project;

	if (tsConfigPath) {
		project = new Project({
			tsConfigFilePath: tsConfigPath,
			skipAddingFilesFromTsConfig: false,
		});
	} else {
		// Fallback: create project without tsconfig
		project = new Project({
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
		// Add source files manually
		project.addSourceFilesAtPaths(join(cwd, "src/**/*.{ts,tsx,js,jsx}"));
	}

	cachedProject = { cwd, project, createdAt: now };
	return project;
}

function findTsConfig(cwd: string): string | undefined {
	// Check common tsconfig locations
	for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
		const p = join(cwd, name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

// ── Main Analysis ──

export async function analyzeWithTypeScript(
	sessionId: string,
	rawDiff: string,
	cwd: string,
	diffFingerprint: string,
): Promise<BehaviorAnalysis> {
	const start = performance.now();
	const warnings: string[] = [];

	// Stage 1: Parse diff for changed file ranges
	const diffFiles = parseDiffRanges(rawDiff);
	const analyzableFiles = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return ANALYZABLE_EXTENSIONS.has(ext);
	});

	if (analyzableFiles.length === 0) {
		return emptyAnalysis(sessionId, diffFingerprint, start, ["No analyzable TS/JS files in the diff."]);
	}

	// Stage 2: Load TypeScript project
	let project: Project;
	try {
		project = getOrCreateProject(cwd);
	} catch (e) {
		warnings.push(`Failed to load TypeScript project: ${e instanceof Error ? e.message : String(e)}`);
		return emptyAnalysis(sessionId, diffFingerprint, start, warnings);
	}

	// Refresh changed files in the project (they may have been edited since last load)
	for (const df of analyzableFiles) {
		const absPath = resolve(cwd, df.filePath);
		const existing = project.getSourceFile(absPath);
		if (existing) {
			existing.refreshFromFileSystemSync();
		} else {
			try {
				project.addSourceFileAtPath(absPath);
			} catch {
				// File may not exist (e.g., untracked new file not yet saved)
			}
		}
	}

	// Build changed ranges map
	const changedRangesMap = new Map<string, ChangedRange[]>();
	for (const df of diffFiles) {
		changedRangesMap.set(df.filePath, df.changedRanges);
	}

	// Stage 3: Find changed symbols using the real AST
	const allSymbols: AnalyzedSymbol[] = [];

	for (const df of analyzableFiles) {
		const absPath = resolve(cwd, df.filePath);
		const sourceFile = project.getSourceFile(absPath);
		if (!sourceFile) {
			warnings.push(`Could not load source file: ${df.filePath}`);
			continue;
		}

		const fileSymbols = extractSymbolsFromFile(sourceFile, df, cwd);
		allSymbols.push(...fileSymbols);
	}

	if (allSymbols.length === 0) {
		return emptyAnalysis(sessionId, diffFingerprint, start, [
			...warnings,
			"No changed function/method declarations found in the diff.",
		]);
	}

	// Stage 4: Detect entrypoints
	const entrypoints = classifyEntrypoints(allSymbols, cwd);

	if (entrypoints.length === 0) {
		warnings.push("No entrypoints detected. All changed symbols listed as untraced.");
	}

	// Stage 5: Build call graphs from entrypoints using type checker
	const behaviors = buildBehaviorsFromEntrypoints(entrypoints, allSymbols, changedRangesMap, cwd, warnings);

	// Stage 6: Identify orphaned symbols
	const tracedKeys = new Set<string>();
	for (const b of behaviors) {
		for (const step of b.steps) {
			tracedKeys.add(step.symbol.qualifiedName ?? step.symbol.name);
		}
	}
	const orphanedSymbols: ChangedSymbol[] = allSymbols
		.filter((s) => s.isChanged && !tracedKeys.has(s.qualifiedName))
		.map(toChangedSymbol);

	if (orphanedSymbols.length > 0) {
		warnings.push(`${orphanedSymbols.length} changed symbol(s) could not be traced to any entrypoint.`);
	}

	// Report non-analyzable files
	const nonAnalyzable = diffFiles.filter((f) => {
		if (f.isDeleted) return false;
		const ext = f.filePath.split(".").pop()?.toLowerCase() ?? "";
		return !ANALYZABLE_EXTENSIONS.has(ext);
	});
	if (nonAnalyzable.length > 0) {
		warnings.push(`${nonAnalyzable.length} non-JS/TS file(s) not analyzed: ${nonAnalyzable.map((f) => f.filePath.split("/").pop()).join(", ")}`);
	}

	return {
		sessionId,
		diffFingerprint,
		behaviors,
		orphanedSymbols,
		analysisTimeMs: Math.round(performance.now() - start),
		createdAt: new Date().toISOString(),
		warnings,
	};
}

// ── Symbol Extraction ──

function extractSymbolsFromFile(sourceFile: SourceFile, diffFile: DiffFileInfo, cwd: string): AnalyzedSymbol[] {
	const symbols: AnalyzedSymbol[] = [];
	const relPath = diffFile.filePath;
	const ranges = diffFile.changedRanges;

	// Walk top-level declarations
	for (const decl of sourceFile.getStatements()) {
		// Exported function declarations
		if (Node.isFunctionDeclaration(decl) && decl.getName()) {
			const sym = makeSymbol(decl, decl.getName()!, "function", relPath, ranges);
			if (sym) symbols.push(sym);
		}
		// Class declarations
		else if (Node.isClassDeclaration(decl) && decl.getName()) {
			const className = decl.getName()!;
			const classSym = makeSymbol(decl, className, "class", relPath, ranges);
			if (classSym) symbols.push(classSym);

			// Methods inside the class
			for (const method of decl.getMethods()) {
				const methodName = method.getName();
				const sym = makeSymbol(method, methodName, "method", relPath, ranges, className);
				if (sym) symbols.push(sym);
			}
		}
		// Variable declarations: const foo = () => {} or const foo = function() {}
		else if (Node.isVariableStatement(decl)) {
			for (const varDecl of decl.getDeclarationList().getDeclarations()) {
				const init = varDecl.getInitializer();
				if (!init) continue;
				// Arrow functions, function expressions, or object literals (export const job = { perform, prePerform })
				if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
					const sym = makeSymbol(varDecl, varDecl.getName(), "function", relPath, ranges);
					if (sym) symbols.push(sym);
				} else if (Node.isObjectLiteralExpression(init)) {
					// Object export — track the object itself and the property values if they're functions
					const sym = makeSymbol(varDecl, varDecl.getName(), "export", relPath, ranges);
					if (sym) symbols.push(sym);
				}
			}
		}
		// Export assignments: export default function() {}
		else if (Node.isExportAssignment(decl)) {
			const expr = decl.getExpression();
			if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
				const sym = makeSymbol(decl, "default", "function", relPath, ranges);
				if (sym) symbols.push(sym);
			}
		}
	}

	// Also find standalone (non-top-level) function declarations that are hoisted
	sourceFile.getFunctions().forEach((fn) => {
		if (!fn.getName()) return;
		// Skip if already captured as a top-level statement
		if (symbols.some((s) => s.name === fn.getName() && s.filePath === relPath)) return;
		const sym = makeSymbol(fn, fn.getName()!, "function", relPath, ranges);
		if (sym) symbols.push(sym);
	});

	return symbols;
}

function makeSymbol(
	node: Node,
	name: string,
	kind: AnalyzedSymbol["kind"],
	filePath: string,
	changedRanges: ChangedRange[],
	className?: string,
): AnalyzedSymbol | null {
	const startLine = node.getStartLineNumber();
	const endLine = node.getEndLineNumber();

	const { isChanged, confidence } = checkOverlap(startLine, endLine, changedRanges);

	// Only include symbols that overlap or are near changed ranges
	if (!isChanged && confidence === "low") return null;

	const qualifiedName = className ? `${className}.${name}` : name;

	return {
		name,
		qualifiedName,
		kind,
		filePath,
		line: startLine,
		endLine,
		isChanged,
		confidence,
		node,
	};
}

function checkOverlap(
	startLine: number,
	endLine: number,
	ranges: ChangedRange[],
): { isChanged: boolean; confidence: ConfidenceLevel } {
	for (const r of ranges) {
		if (startLine <= r.end && endLine >= r.start) {
			return { isChanged: true, confidence: "high" };
		}
	}
	for (const r of ranges) {
		if (startLine <= r.end + 5 && endLine >= r.start - 5) {
			return { isChanged: false, confidence: "medium" };
		}
	}
	return { isChanged: false, confidence: "low" };
}

// ── Entrypoint Detection ──

function classifyEntrypoints(symbols: AnalyzedSymbol[], cwd: string): AnalyzedEntrypoint[] {
	const entrypoints: AnalyzedEntrypoint[] = [];
	const seen = new Set<string>();

	for (const sym of symbols) {
		if (!sym.isChanged) continue;
		if (sym.kind === "type" || sym.kind === "export") continue;
		if (seen.has(sym.qualifiedName)) continue;

		const ep = classifySingleEntrypoint(sym, cwd);
		if (ep) {
			seen.add(sym.qualifiedName);
			entrypoints.push(ep);
		}
	}

	return entrypoints;
}

function classifySingleEntrypoint(sym: AnalyzedSymbol, cwd: string): AnalyzedEntrypoint | null {
	const fp = sym.filePath;

	// Next.js App Router routes
	if (/\/app\/.*\/route\.(ts|js|tsx|jsx)$/.test(fp) && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(sym.name)) {
		return { symbol: sym, kind: "api-route", confidence: "high" };
	}

	// Next.js Pages API
	if (/\/pages\/api\//.test(fp) && (sym.name === "default" || sym.name === "handler")) {
		return { symbol: sym, kind: "api-route", confidence: "high" };
	}

	// Job files (*.job.ts, jobs/**)
	if (/\.(job|worker)\.(ts|js)$/.test(fp) || /\/jobs?\//.test(fp)) {
		if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(sym.name)) {
			return { symbol: sym, kind: "queue-consumer", confidence: "high" };
		}
		// Any exported function in a job file is likely part of the job
		if (isExported(sym.node)) {
			return { symbol: sym, kind: "queue-consumer", confidence: "medium" };
		}
	}

	// Cron files
	if (/\/crons?\//.test(fp) || /\.cron\.(ts|js)$/.test(fp)) {
		if (/^(perform|prePerform|postPerform|execute|run|handle)$/.test(sym.name)) {
			return { symbol: sym, kind: "cron-job", confidence: "high" };
		}
		if (isExported(sym.node)) {
			return { symbol: sym, kind: "cron-job", confidence: "medium" };
		}
	}

	// Test files
	if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(fp) || /__tests__\//.test(fp)) {
		if (sym.name === "describe" || sym.kind === "function") {
			return { symbol: sym, kind: "test-function", confidence: "high" };
		}
	}

	// React components (pages)
	if (/\/app\/.*\/page\.(tsx|jsx)$/.test(fp)) {
		return { symbol: sym, kind: "react-component", confidence: "high" };
	}

	// Express/Koa routes — check if the function body registers routes
	if (sym.kind === "function" && isExported(sym.node)) {
		const text = sym.node.getText();
		if (/\b(app|router)\.(get|post|put|delete|patch|use)\s*\(/.test(text)) {
			return { symbol: sym, kind: "api-route", confidence: "high" };
		}
	}

	// Exported functions in service/controller/handler files
	if (isExported(sym.node) && sym.kind === "function") {
		if (/\b(controller|handler|service|route|api|endpoint)\b/i.test(fp)) {
			return { symbol: sym, kind: "exported-function", confidence: "medium" };
		}
	}

	// Generic exported function — only if it's a top-level export
	if (isExported(sym.node) && sym.kind === "function") {
		return { symbol: sym, kind: "exported-function", confidence: "low" };
	}

	return null;
}

function isExported(node: Node): boolean {
	// Check if the node itself has export keyword
	if (Node.isExportable(node) && node.isExported()) return true;
	// Check if parent variable statement is exported
	const parent = node.getParent();
	if (parent && Node.isVariableDeclarationList(parent)) {
		const varStmt = parent.getParent();
		if (varStmt && Node.isVariableStatement(varStmt)) {
			return varStmt.isExported();
		}
	}
	return false;
}

// ── Call Graph via Type Checker ──

const MAX_DEPTH = 8;
const MAX_STEPS = 25;

function buildBehaviorsFromEntrypoints(
	entrypoints: AnalyzedEntrypoint[],
	allSymbols: AnalyzedSymbol[],
	changedRangesMap: Map<string, ChangedRange[]>,
	cwd: string,
	warnings: string[],
): ChangedBehavior[] {
	const behaviors: ChangedBehavior[] = [];

	// Index symbols by qualified name for lookup
	const symbolMap = new Map<string, AnalyzedSymbol>();
	for (const sym of allSymbols) {
		symbolMap.set(sym.qualifiedName, sym);
	}

	for (const ep of entrypoints) {
		try {
			const behaviorId = randomUUID();
			const steps: ExecutionStep[] = [];
			const visited = new Set<string>();

			traceCallChain(ep.symbol, steps, visited, 0, behaviorId, symbolMap, changedRangesMap, cwd);

			if (steps.length === 0) continue;

			// Aggregate
			const sideEffectKeys = new Set<string>();
			const aggregateSideEffects: SideEffect[] = [];
			const touchedFiles = new Set<string>();
			let changedCount = 0;

			for (const step of steps) {
				touchedFiles.add(step.symbol.location.filePath);
				if (step.isChanged) changedCount++;
				for (const se of step.sideEffects) {
					const key = `${se.kind}:${se.description}`;
					if (!sideEffectKeys.has(key)) {
						sideEffectKeys.add(key);
						aggregateSideEffects.push(se);
					}
				}
			}

			const minConf = steps.reduce<ConfidenceLevel>((acc, s) => {
				const rank = { high: 2, medium: 1, low: 0 };
				return rank[s.confidence] < rank[acc] ? s.confidence : acc;
			}, "high");

			behaviors.push({
				id: behaviorId,
				name: buildBehaviorName(ep),
				entrypointKind: ep.kind,
				entrypoint: toChangedSymbol(ep.symbol),
				steps,
				sideEffects: aggregateSideEffects,
				touchedFiles: Array.from(touchedFiles),
				changedStepCount: changedCount,
				totalStepCount: steps.length,
				confidence: minConf,
			});
		} catch (e) {
			warnings.push(`Error tracing ${ep.symbol.qualifiedName}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return behaviors;
}

function traceCallChain(
	sym: AnalyzedSymbol,
	steps: ExecutionStep[],
	visited: Set<string>,
	depth: number,
	behaviorId: string,
	symbolMap: Map<string, AnalyzedSymbol>,
	changedRangesMap: Map<string, ChangedRange[]>,
	cwd: string,
): void {
	if (depth > MAX_DEPTH || steps.length >= MAX_STEPS) return;
	if (visited.has(sym.qualifiedName)) return;
	visited.add(sym.qualifiedName);

	// Get the function body text for side-effect detection
	const bodyText = sym.node.getText();
	const bodyLines = bodyText.split("\n");
	const sideEffects = detectSideEffects(bodyLines, sym.filePath, sym.line);

	// Mark side effects changed status
	const fileRanges = changedRangesMap.get(sym.filePath) ?? [];
	for (const se of sideEffects) {
		for (const r of fileRanges) {
			if (se.location.line >= r.start && se.location.line <= r.end) {
				se.location.isChanged = true;
				break;
			}
		}
	}

	// Build snippet (content omitted for persistence; filled by API detail endpoint)
	const snippet: CodeSnippet = {
		filePath: sym.filePath,
		startLine: Math.max(1, sym.line - 2),
		endLine: sym.endLine + 2,
		language: detectLang(sym.filePath),
	};

	// Find outgoing calls using the type checker
	const calleeKeys = resolveOutgoingCalls(sym.node, symbolMap, cwd);

	const step: ExecutionStep = {
		id: `${behaviorId}-step-${steps.length}`,
		order: steps.length,
		symbol: toChangedSymbol(sym),
		snippet,
		sideEffects,
		callsTo: calleeKeys,
		rationale: depth === 0 ? "Entry point" : sym.isChanged ? "Modified by this diff" : "Called on the path to modified code",
		isChanged: sym.isChanged,
		confidence: sym.confidence,
	};

	steps.push(step);

	// Recurse into callees that are known symbols
	for (const key of calleeKeys) {
		const calleeSym = symbolMap.get(key);
		if (calleeSym) {
			traceCallChain(calleeSym, steps, visited, depth + 1, behaviorId, symbolMap, changedRangesMap, cwd);
		}
	}
}

/**
 * Use the TypeScript type checker to resolve outgoing calls from a function/method node.
 * Returns qualified names of called symbols that are in our symbol map.
 */
function resolveOutgoingCalls(node: Node, symbolMap: Map<string, AnalyzedSymbol>, cwd: string): string[] {
	const calleeKeys: string[] = [];
	const seen = new Set<string>();

	try {
		// Find all call expressions inside this node
		const callExpressions = node.getDescendantsOfKind(SyntaxKind.CallExpression);

		for (const call of callExpressions) {
			try {
				const expr = call.getExpression();
				let resolvedName: string | null = null;

				// Try to resolve via the type checker
				const symbol = expr.getSymbol();
				if (symbol) {
					// Get the declaration to find the real name and file
					const declarations = symbol.getDeclarations();
					if (declarations.length > 0) {
						const decl = declarations[0];
						const declFile = decl.getSourceFile().getFilePath();
						const relPath = makeRelative(declFile, cwd);
						const declName = symbol.getName();

						// Check if this matches a symbol we're tracking
						// Try both qualified and simple names
						const parentClass = getParentClassName(decl);
						const qualified = parentClass ? `${parentClass}.${declName}` : declName;

						if (symbolMap.has(qualified)) {
							resolvedName = qualified;
						} else if (symbolMap.has(declName)) {
							resolvedName = declName;
						}
					}
				}

				// Fallback: try identifier name matching
				if (!resolvedName) {
					const name = getCallName(expr);
					if (name && symbolMap.has(name)) {
						resolvedName = name;
					}
				}

				if (resolvedName && !seen.has(resolvedName)) {
					seen.add(resolvedName);
					calleeKeys.push(resolvedName);
				}
			} catch {
				// Individual call resolution can fail — skip it
			}
		}
	} catch {
		// If descendant traversal fails, return empty
	}

	return calleeKeys;
}

function getCallName(expr: Node): string | null {
	// foo() → "foo"
	if (Node.isIdentifier(expr)) return expr.getText();
	// this.foo() or obj.foo() → "foo" (or "Class.foo")
	if (Node.isPropertyAccessExpression(expr)) {
		const propName = expr.getName();
		const objExpr = expr.getExpression();
		if (Node.isThisExpression(objExpr)) {
			// Try to find the containing class
			const cls = expr.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
			if (cls?.getName()) return `${cls.getName()}.${propName}`;
		}
		return propName;
	}
	return null;
}

function getParentClassName(node: Node): string | null {
	const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
	return cls?.getName() ?? null;
}

// ── Helpers ──

function makeRelative(absPath: string, cwd: string): string {
	const cwdNormalized = cwd.endsWith("/") ? cwd : cwd + "/";
	if (absPath.startsWith(cwdNormalized)) {
		return absPath.slice(cwdNormalized.length);
	}
	return absPath;
}

function toChangedSymbol(sym: AnalyzedSymbol): ChangedSymbol {
	return {
		name: sym.name,
		kind: sym.kind,
		location: {
			filePath: sym.filePath,
			line: sym.line,
			endLine: sym.endLine,
			isChanged: sym.isChanged,
		},
		qualifiedName: sym.qualifiedName,
		confidence: sym.confidence,
	};
}

function detectLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
		mjs: "javascript", cjs: "javascript",
	};
	return map[ext] ?? "text";
}

function buildBehaviorName(ep: AnalyzedEntrypoint): string {
	const sym = ep.symbol;
	const fileName = sym.filePath.split("/").pop() ?? "";
	const jobName = fileName.replace(/\.(job|worker|cron)\.(ts|js)$/, "");

	switch (ep.kind) {
		case "api-route": {
			const method = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(sym.name) ? sym.name.toUpperCase() : "";
			const routeMatch = sym.filePath.match(/(?:app|pages)(\/api\/[^.]+)\/route\.\w+$/);
			const routePath = routeMatch ? routeMatch[1] : "";
			if (method && routePath) return `${method} ${routePath}`;
			if (method) return `${method} (${fileName})`;
			return `${sym.name} (${fileName})`;
		}
		case "test-function":
			return `test: ${jobName}`;
		case "react-component":
			return `<${sym.name} />`;
		case "event-handler":
			return `on: ${sym.name}`;
		case "queue-consumer": {
			if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(sym.name)) {
				return `job: ${jobName}.${sym.name}`;
			}
			return `job: ${sym.name}`;
		}
		case "cli-command":
			return `cmd: ${sym.name}`;
		case "cron-job": {
			if (/^(perform|prePerform|postPerform|execute|run|handle)$/.test(sym.name)) {
				return `cron: ${jobName}.${sym.name}`;
			}
			return `cron: ${sym.name}`;
		}
		default:
			return sym.qualifiedName ?? sym.name;
	}
}

function emptyAnalysis(
	sessionId: string,
	diffFingerprint: string,
	startTime: number,
	warnings: string[],
): BehaviorAnalysis {
	return {
		sessionId,
		diffFingerprint,
		behaviors: [],
		orphanedSymbols: [],
		analysisTimeMs: Math.round(performance.now() - startTime),
		createdAt: new Date().toISOString(),
		warnings,
	};
}

/** Invalidate the cached project (e.g., when switching repos). */
export function invalidateProjectCache(): void {
	cachedProject = null;
}
