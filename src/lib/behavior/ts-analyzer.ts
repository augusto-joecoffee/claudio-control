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

	// Diagnostic: report symbol counts
	const changedSymCount = allSymbols.filter((s) => s.isChanged).length;
	warnings.push(`Analysis: ${allSymbols.length} symbols found (${changedSymCount} changed), ${entrypoints.length} entrypoints detected.`);

	// Stage 5: Build call graphs from entrypoints using type checker
	const symbolMapSize = allSymbols.length;
	const behaviors = buildBehaviorsFromEntrypoints(entrypoints, allSymbols, changedRangesMap, cwd, warnings);

	// Diagnostic: report how many symbols were discovered on-the-fly
	// The symbolMap inside buildBehaviorsFromEntrypoints grows as calls are traced
	const totalTraced = behaviors.reduce((sum, b) => sum + b.totalStepCount, 0);
	warnings.push(`Tracing: ${totalTraced} steps across ${behaviors.length} flows.`);

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

/** Max depth when tracing call chains (includes unchanged intermediate steps). */
const MAX_TRACE_DEPTH = 12;
/** Max steps to keep after filtering for display. */
const MAX_DISPLAY_STEPS = 20;
/** Max raw steps during tracing (before filtering). */
const MAX_RAW_STEPS = 60;

interface RawStep {
	sym: AnalyzedSymbol;
	sideEffects: SideEffect[];
	calleeKeys: string[];
	depth: number;
}

function buildBehaviorsFromEntrypoints(
	entrypoints: AnalyzedEntrypoint[],
	allSymbols: AnalyzedSymbol[],
	changedRangesMap: Map<string, ChangedRange[]>,
	cwd: string,
	warnings: string[],
): ChangedBehavior[] {
	const behaviors: ChangedBehavior[] = [];

	// Index symbols by qualified name for lookup.
	// This map GROWS during tracing as we discover symbols in unchanged files.
	const symbolMap = new Map<string, AnalyzedSymbol>();
	for (const sym of allSymbols) {
		symbolMap.set(sym.qualifiedName, sym);
	}

	for (const ep of entrypoints) {
		try {
			const behaviorId = randomUUID();
			const visited = new Set<string>();

			// Pass 1: Trace the full call chain, including through unchanged code
			const rawSteps: RawStep[] = [];
			traceCallChainFull(ep.symbol, rawSteps, visited, 0, symbolMap, changedRangesMap, cwd);

			if (rawSteps.length === 0) continue;

			// Pass 2: Filter to steps the reviewer should see
			const filteredSteps = filterRelevantSteps(rawSteps);
			if (filteredSteps.length === 0) continue;

			// Build ExecutionStep objects from the filtered raw steps
			const steps: ExecutionStep[] = filteredSteps.map((raw, i) => ({
				id: `${behaviorId}-step-${i}`,
				order: i,
				symbol: toChangedSymbol(raw.sym),
				snippet: {
					filePath: raw.sym.filePath,
					startLine: Math.max(1, raw.sym.line - 2),
					endLine: raw.sym.endLine + 2,
					language: detectLang(raw.sym.filePath),
				},
				sideEffects: raw.sideEffects,
				callsTo: raw.calleeKeys,
				rationale: raw.depth === 0
					? "Entry point"
					: raw.sym.isChanged
						? "Modified by this diff"
						: raw.sideEffects.length > 0
							? "Has side effects"
							: "Called on the path to modified code",
				isChanged: raw.sym.isChanged,
				confidence: raw.sym.confidence,
			}));

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

/**
 * Pass 1: Trace the full call chain from an entrypoint, following calls
 * through UNCHANGED code. When the type checker resolves a call to a function
 * not in our symbolMap, we create an AnalyzedSymbol on-the-fly and continue.
 */
function traceCallChainFull(
	sym: AnalyzedSymbol,
	steps: RawStep[],
	visited: Set<string>,
	depth: number,
	symbolMap: Map<string, AnalyzedSymbol>,
	changedRangesMap: Map<string, ChangedRange[]>,
	cwd: string,
): void {
	if (depth > MAX_TRACE_DEPTH || steps.length >= MAX_RAW_STEPS) return;
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

	// Resolve outgoing calls — this may add NEW symbols to symbolMap on-the-fly
	const calleeKeys = resolveOutgoingCalls(sym.node, symbolMap, cwd);

	steps.push({ sym, sideEffects, calleeKeys, depth });

	// Recurse into ALL resolved callees (changed or unchanged)
	for (const key of calleeKeys) {
		const calleeSym = symbolMap.get(key);
		if (calleeSym) {
			traceCallChainFull(calleeSym, steps, visited, depth + 1, symbolMap, changedRangesMap, cwd);
		}
	}
}

/**
 * Pass 2: Filter raw steps to keep only what the reviewer should see.
 *
 * Keep:
 * - The entrypoint (depth 0) — always
 * - Steps with isChanged — always (the diff touched this code)
 * - Steps with side effects — always (DB writes, HTTP calls, etc.)
 * - Steps that are direct parent/child of a kept step — bridge context
 *
 * Drop everything else (unchanged boilerplate in the middle of the chain).
 */
function filterRelevantSteps(rawSteps: RawStep[]): RawStep[] {
	if (rawSteps.length <= MAX_DISPLAY_STEPS) {
		// Small enough to show everything
		return rawSteps;
	}

	// Mark which steps to keep
	const keepIndices = new Set<number>();

	// Always keep entrypoint
	keepIndices.add(0);

	// Keep changed steps and steps with side effects
	for (let i = 0; i < rawSteps.length; i++) {
		if (rawSteps[i].sym.isChanged || rawSteps[i].sideEffects.length > 0) {
			keepIndices.add(i);
		}
	}

	// Keep bridge steps: direct callers/callees of kept steps
	// Build a caller→callee index from the raw steps
	const qualifiedToIndex = new Map<string, number>();
	for (let i = 0; i < rawSteps.length; i++) {
		qualifiedToIndex.set(rawSteps[i].sym.qualifiedName, i);
	}

	const bridgePass = new Set(keepIndices);
	for (const idx of keepIndices) {
		const step = rawSteps[idx];
		// Keep callees of this step
		for (const calleeKey of step.calleeKeys) {
			const calleeIdx = qualifiedToIndex.get(calleeKey);
			if (calleeIdx !== undefined) bridgePass.add(calleeIdx);
		}
		// Keep the step that calls this one (parent)
		if (idx > 0) {
			for (let j = idx - 1; j >= 0; j--) {
				if (rawSteps[j].calleeKeys.includes(step.sym.qualifiedName)) {
					bridgePass.add(j);
					break;
				}
			}
		}
	}

	// Collect and sort by original order, cap at MAX_DISPLAY_STEPS
	const filtered = Array.from(bridgePass)
		.sort((a, b) => a - b)
		.slice(0, MAX_DISPLAY_STEPS)
		.map((i) => rawSteps[i]);

	return filtered;
}

/**
 * Resolve outgoing calls from a function/method node using the TypeScript type checker.
 *
 * CRITICAL: When the type checker resolves a call to a function NOT in symbolMap,
 * we create an AnalyzedSymbol on-the-fly and ADD it to symbolMap. This allows
 * traceCallChainFull to follow the chain through unchanged code.
 *
 * Uses multiple resolution strategies because getSymbol() alone misses many
 * common patterns (aliased imports, property access chains, re-exports).
 */
function resolveOutgoingCalls(node: Node, symbolMap: Map<string, AnalyzedSymbol>, cwd: string): string[] {
	const calleeKeys: string[] = [];
	const seen = new Set<string>();

	try {
		const callExpressions = node.getDescendantsOfKind(SyntaxKind.CallExpression);

		for (const call of callExpressions) {
			try {
				const resolved = resolveCallExpression(call, symbolMap, cwd);
				if (resolved && !seen.has(resolved)) {
					seen.add(resolved);
					calleeKeys.push(resolved);
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

/**
 * Try multiple strategies to resolve a single call expression to a qualified name
 * in the symbolMap. Creates on-the-fly symbols for calls to unchanged code.
 */
function resolveCallExpression(call: Node, symbolMap: Map<string, AnalyzedSymbol>, cwd: string): string | null {
	const expr = (call as any).getExpression?.() as Node | undefined;
	if (!expr) return null;

	// Strategy 1: getSymbol() on the expression
	let tsSym = expr.getSymbol?.() ?? null;

	// Strategy 2: For aliased imports, follow the alias
	if (tsSym) {
		try {
			const aliased = tsSym.getAliasedSymbol?.();
			if (aliased) tsSym = aliased;
		} catch { /* not an alias */ }
	}

	// Strategy 3: For property access (this.foo(), obj.foo()), try the property symbol
	if (!tsSym && Node.isPropertyAccessExpression(expr)) {
		try {
			const nameNode = expr.getNameNode();
			tsSym = nameNode.getSymbol?.() ?? null;
			if (tsSym) {
				try {
					const aliased = tsSym.getAliasedSymbol?.();
					if (aliased) tsSym = aliased;
				} catch { /* not an alias */ }
			}
		} catch { /* ignore */ }
	}

	// Strategy 4: Use the type of the expression to find the call signature
	if (!tsSym) {
		try {
			const exprType = expr.getType();
			const callSignatures = exprType.getCallSignatures();
			if (callSignatures.length > 0) {
				const returnDecl = callSignatures[0].getDeclaration();
				if (returnDecl) {
					tsSym = returnDecl.getSymbol?.() ?? null;
				}
			}
		} catch { /* ignore */ }
	}

	if (!tsSym) return null;

	const declarations = tsSym.getDeclarations();
	if (declarations.length === 0) return null;

	const decl = declarations[0];
	const declFile = decl.getSourceFile().getFilePath();

	// Skip calls into node_modules
	if (declFile.includes("/node_modules/")) return null;

	const relPath = makeRelative(declFile, cwd);
	// Skip if the file is outside the project
	if (relPath.startsWith("/")) return null;

	const declName = tsSym.getName();
	// Skip anonymous or internal names
	if (!declName || declName === "__function" || declName === "__object") return null;

	const parentClass = getParentClassName(decl);
	const qualified = parentClass ? `${parentClass}.${declName}` : declName;

	// Check if already in symbolMap
	if (symbolMap.has(qualified)) return qualified;
	if (symbolMap.has(declName)) return declName;

	// NOT in symbolMap — create on-the-fly if it's a function-like thing
	const funcNode = findFunctionNode(decl);
	if (!funcNode) return null;

	const newSym: AnalyzedSymbol = {
		name: declName,
		qualifiedName: qualified,
		kind: parentClass ? "method" : "function",
		filePath: relPath,
		line: funcNode.getStartLineNumber(),
		endLine: funcNode.getEndLineNumber(),
		isChanged: false,
		confidence: "high",
		node: funcNode,
	};
	symbolMap.set(qualified, newSym);
	return qualified;
}

/**
 * Given a declaration node, find the actual function body node we can trace into.
 * Handles: FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression,
 * VariableDeclaration (with fn initializer), PropertyAssignment, ShorthandPropertyAssignment,
 * and follows through to the value expression where possible.
 */
function findFunctionNode(decl: Node): Node | null {
	// Direct function/method declarations
	if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
		return decl;
	}
	// Arrow functions and function expressions directly
	if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
		return decl;
	}
	// Variable declaration: const foo = () => {} or const foo = function() {}
	if (Node.isVariableDeclaration(decl)) {
		const init = decl.getInitializer();
		if (!init) return null;
		if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return init;
		// const foo = someOtherFunction — follow through
		if (Node.isIdentifier(init)) {
			const sym = init.getSymbol();
			if (sym) {
				const innerDecls = sym.getDeclarations();
				if (innerDecls.length > 0) return findFunctionNode(innerDecls[0]);
			}
		}
		return null;
	}
	// PropertyAssignment: { foo: () => {} }
	if (Node.isPropertyAssignment(decl)) {
		const init = decl.getInitializer();
		if (!init) return null;
		if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return init;
		// { foo: someFunc } — follow through
		if (Node.isIdentifier(init)) {
			const sym = init.getSymbol();
			if (sym) {
				const innerDecls = sym.getDeclarations();
				if (innerDecls.length > 0) return findFunctionNode(innerDecls[0]);
			}
		}
		return null;
	}
	// ShorthandPropertyAssignment: { perform } — follow to the referenced value
	if (Node.isShorthandPropertyAssignment(decl)) {
		try {
			const sym = decl.getNameNode().getSymbol();
			if (sym) {
				// Follow the alias to the actual declaration
				const aliased = sym.getAliasedSymbol?.() ?? sym;
				const innerDecls = aliased.getDeclarations();
				if (innerDecls.length > 0) return findFunctionNode(innerDecls[0]);
			}
		} catch { /* ignore */ }
		return null;
	}
	// GetAccessor/SetAccessor
	if (Node.isGetAccessorDeclaration(decl) || Node.isSetAccessorDeclaration(decl)) {
		return decl;
	}
	return null;
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
