/**
 * Generate ordered execution paths from entrypoints through the call graph.
 * DFS-based, with cycle detection, depth limits, and side-effect annotation.
 */

import { randomUUID } from "crypto";
import type { ChangedBehavior, ChangedSymbol, ExecutionStep, SideEffect, EntrypointKind, ConfidenceLevel } from "../types";
import type { DetectedEntrypoint } from "./entrypoint-detector";
import type { ChangedRange } from "./diff-symbols";
import { detectSideEffects } from "./side-effect-detector";
import { extractSnippetFromLines } from "./snippet-extractor";
import { minConfidence, scoreBehaviorConfidence } from "./confidence";

const MAX_DEPTH = 10;
const MAX_STEPS = 20;

interface PathContext {
	graph: Map<string, string[]>;
	symbolMap: Map<string, ChangedSymbol>;
	fileLines: Map<string, string[]>;
	changedRangesMap: Map<string, ChangedRange[]>;
	behaviorId: string;
}

/**
 * Generate execution paths for all detected entrypoints.
 */
export function generateExecutionPaths(
	entrypoints: DetectedEntrypoint[],
	allSymbols: ChangedSymbol[],
	graph: Map<string, string[]>,
	fileLines: Map<string, string[]>,
	changedRangesMap: Map<string, ChangedRange[]>,
): ChangedBehavior[] {
	// Build lookup: qualifiedName → ChangedSymbol
	const symbolMap = new Map<string, ChangedSymbol>();
	for (const sym of allSymbols) {
		const key = sym.qualifiedName ?? sym.name;
		symbolMap.set(key, sym);
	}

	const behaviors: ChangedBehavior[] = [];

	for (const ep of entrypoints) {
		const behaviorId = randomUUID();
		const ctx: PathContext = { graph, symbolMap, fileLines, changedRangesMap, behaviorId };

		const steps: ExecutionStep[] = [];
		const visited = new Set<string>();

		walkPath(ctx, ep.symbol, ep.kind, steps, visited, 0);

		if (steps.length === 0) continue;

		// Aggregate side effects across all steps
		const allSideEffects: SideEffect[] = [];
		const sideEffectKeys = new Set<string>();
		const touchedFiles = new Set<string>();

		for (const step of steps) {
			touchedFiles.add(step.symbol.location.filePath);
			for (const se of step.sideEffects) {
				const key = `${se.kind}:${se.description}`;
				if (!sideEffectKeys.has(key)) {
					sideEffectKeys.add(key);
					allSideEffects.push(se);
				}
			}
		}

		const changedStepCount = steps.filter((s) => s.isChanged).length;

		// Build human-readable name
		const name = buildBehaviorName(ep);

		behaviors.push({
			id: behaviorId,
			name,
			entrypointKind: ep.kind,
			entrypoint: ep.symbol,
			steps,
			sideEffects: allSideEffects,
			touchedFiles: Array.from(touchedFiles),
			changedStepCount,
			totalStepCount: steps.length,
			confidence: scoreBehaviorConfidence(steps),
		});
	}

	return behaviors;
}

function walkPath(
	ctx: PathContext,
	symbol: ChangedSymbol,
	entrypointKind: EntrypointKind,
	steps: ExecutionStep[],
	visited: Set<string>,
	depth: number,
): void {
	if (depth > MAX_DEPTH) return;
	if (steps.length >= MAX_STEPS) return;

	const key = symbol.qualifiedName ?? symbol.name;
	if (visited.has(key)) return; // Cycle detection
	visited.add(key);

	// Get the symbol's code lines
	const lines = ctx.fileLines.get(symbol.location.filePath);
	if (!lines) return;

	const startLine = symbol.location.line;
	const endLine = symbol.location.endLine ?? startLine + 10;
	const bodyLines = lines.slice(startLine - 1, endLine);

	// Detect side effects in this symbol's body
	const sideEffects = detectSideEffects(bodyLines, symbol.location.filePath, startLine);

	// Mark side effect locations as changed if within changed ranges
	const fileRanges = ctx.changedRangesMap.get(symbol.location.filePath) ?? [];
	for (const se of sideEffects) {
		for (const range of fileRanges) {
			if (se.location.line >= range.start && se.location.line <= range.end) {
				se.location.isChanged = true;
				break;
			}
		}
	}

	// Build snippet (without content for persisted form; content added on API detail request)
	const snippet = extractSnippetFromLines(lines, symbol.location.filePath, startLine, endLine);

	// Get callees
	const callees = ctx.graph.get(key) ?? [];

	// Build rationale
	let rationale: string;
	if (depth === 0) {
		rationale = "Entry point";
	} else if (symbol.location.isChanged) {
		rationale = `Modified by this diff`;
	} else {
		rationale = `Called on the path to modified code`;
	}

	const stepConfidence: ConfidenceLevel = depth === 0
		? symbol.confidence
		: minConfidence(symbol.confidence, depth <= 2 ? "high" : "medium");

	const step: ExecutionStep = {
		id: `${ctx.behaviorId}-step-${steps.length}`,
		order: steps.length,
		symbol,
		snippet,
		sideEffects,
		callsTo: callees,
		rationale,
		isChanged: symbol.location.isChanged,
		confidence: stepConfidence,
	};

	steps.push(step);

	// Recurse into callees
	for (const calleeKey of callees) {
		const calleeSym = ctx.symbolMap.get(calleeKey);
		if (!calleeSym) continue;

		// Only follow the edge if the callee is changed or leads to changed code
		// For V1, we follow all edges (the MAX_DEPTH/MAX_STEPS limits prevent runaway)
		walkPath(ctx, calleeSym, entrypointKind, steps, visited, depth + 1);
	}
}

function buildBehaviorName(ep: DetectedEntrypoint): string {
	const sym = ep.symbol;
	const fileName = sym.location.filePath.split("/").pop() ?? "";
	// Extract a readable job/file name: "calculateDailyLoyaltyFees.job.ts" → "calculateDailyLoyaltyFees"
	const jobName = fileName.replace(/\.(job|worker|cron)\.(ts|js)$/, "");

	switch (ep.kind) {
		case "api-route": {
			// Try to extract HTTP method from symbol name
			const method = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(sym.name) ? sym.name.toUpperCase() : "";
			// Extract route path from file path (e.g., app/api/users/route.ts → /api/users)
			const routeMatch = sym.location.filePath.match(/(?:app|pages)(\/api\/[^.]+)\/route\.\w+$/);
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
			// For job files, use the file name not the method name (perform → calculateDailyLoyaltyFees)
			if (/^(perform|prePerform|postPerform|execute|run|handle|process)$/.test(sym.name)) {
				return `job: ${jobName}.${sym.name}`;
			}
			return `queue: ${sym.name}`;
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
