/**
 * Parse Claude's JSON response into BehaviorAnalysis.
 * Handles malformed JSON gracefully — Claude may include markdown fences
 * or extra text around the JSON.
 */

import { randomUUID } from "crypto";
import type {
	BehaviorAnalysis, ChangedBehavior, ExecutionStep, ChangedSymbol,
	SideEffect, CodeSnippet, EntrypointKind, ConfidenceLevel, SideEffectKind,
} from "../types";

interface RawStep {
	filePath?: string;
	symbolName?: string;
	line?: number;
	isChanged?: boolean;
	rationale?: string;
	sideEffects?: Array<{ kind?: string; description?: string }>;
}

interface RawFlow {
	name?: string;
	entrypointKind?: string;
	confidence?: string;
	entrypoints?: RawStep[];
	steps?: RawStep[];
}

interface RawResponse {
	flows?: RawFlow[];
}

const VALID_ENTRYPOINT_KINDS: EntrypointKind[] = [
	"api-route", "queue-consumer", "cron-job", "event-handler",
	"exported-function", "react-component", "test-function", "cli-command", "unknown",
];

const VALID_SIDE_EFFECT_KINDS: SideEffectKind[] = [
	"db-write", "db-read", "http-request", "queue-publish",
	"cache-write", "cache-read", "event-emit", "file-io", "process-exit", "external-sdk",
];

const VALID_CONFIDENCE: ConfidenceLevel[] = ["high", "medium", "low"];

/**
 * Parse Claude's response text into a BehaviorAnalysis.
 * Extracts JSON from the response, handling markdown fences and extra text.
 */
export function parseClaudeResponse(
	responseText: string,
	sessionId: string,
	diffFingerprint: string,
	analysisTimeMs: number,
): BehaviorAnalysis {
	const warnings: string[] = [];

	// Try to extract JSON from the response
	const json = extractJson(responseText);
	if (!json) {
		warnings.push("Could not extract JSON from Claude's response.");
		return emptyResult(sessionId, diffFingerprint, analysisTimeMs, warnings);
	}

	let parsed: RawResponse;
	try {
		parsed = JSON.parse(json);
	} catch (e) {
		warnings.push(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
		return emptyResult(sessionId, diffFingerprint, analysisTimeMs, warnings);
	}

	if (!parsed.flows || !Array.isArray(parsed.flows)) {
		warnings.push("Response missing 'flows' array.");
		return emptyResult(sessionId, diffFingerprint, analysisTimeMs, warnings);
	}

	// Map raw flows to ChangedBehavior[]
	const behaviors: ChangedBehavior[] = [];
	for (const rawFlow of parsed.flows) {
		const behavior = mapFlow(rawFlow, warnings);
		if (behavior) behaviors.push(behavior);
	}

	warnings.push(`Parsed ${behaviors.length} flows from Claude's response.`);

	return {
		sessionId,
		diffFingerprint,
		behaviors,
		orphanedSymbols: [],
		analysisTimeMs,
		createdAt: new Date().toISOString(),
		warnings,
	};
}

function mapFlow(raw: RawFlow, warnings: string[]): ChangedBehavior | null {
	if (!raw.name || !raw.steps || raw.steps.length === 0) return null;

	const behaviorId = randomUUID();
	const entrypointKind = VALID_ENTRYPOINT_KINDS.includes(raw.entrypointKind as EntrypointKind)
		? (raw.entrypointKind as EntrypointKind)
		: "exported-function";

	const confidence = VALID_CONFIDENCE.includes(raw.confidence as ConfidenceLevel)
		? (raw.confidence as ConfidenceLevel)
		: "medium";

	const steps: ExecutionStep[] = [];
	const allSideEffects: SideEffect[] = [];
	const sideEffectKeys = new Set<string>();
	const touchedFiles = new Set<string>();
	let changedCount = 0;

	for (let i = 0; i < raw.steps.length; i++) {
		const rawStep = raw.steps[i];
		if (!rawStep.filePath || !rawStep.symbolName) continue;

		const filePath = rawStep.filePath;
		const line = rawStep.line ?? 1;
		const isChanged = rawStep.isChanged ?? false;

		if (isChanged) changedCount++;
		touchedFiles.add(filePath);

		const symbol: ChangedSymbol = {
			name: rawStep.symbolName,
			kind: "function",
			location: {
				filePath,
				line,
				endLine: line + 20, // approximate — will be refined by snippet hydration
				isChanged,
			},
			qualifiedName: rawStep.symbolName,
			confidence,
		};

		const stepSideEffects: SideEffect[] = [];
		if (rawStep.sideEffects) {
			for (const rawSe of rawStep.sideEffects) {
				if (!rawSe.kind || !rawSe.description) continue;
				const kind = VALID_SIDE_EFFECT_KINDS.includes(rawSe.kind as SideEffectKind)
					? (rawSe.kind as SideEffectKind)
					: ("db-write" as SideEffectKind); // fallback

				const se: SideEffect = {
					kind,
					description: rawSe.description,
					location: { filePath, line, isChanged },
					confidence,
				};
				stepSideEffects.push(se);

				const key = `${kind}:${rawSe.description}`;
				if (!sideEffectKeys.has(key)) {
					sideEffectKeys.add(key);
					allSideEffects.push(se);
				}
			}
		}

		const snippet: CodeSnippet = {
			filePath,
			startLine: Math.max(1, line - 2),
			endLine: line + 20,
			language: detectLang(filePath),
			// content omitted — hydrated by detail API endpoint
		};

		steps.push({
			id: `${behaviorId}-step-${i}`,
			order: i,
			symbol,
			snippet,
			sideEffects: stepSideEffects,
			callsTo: [], // Claude doesn't return this — it's implicit in step ordering
			rationale: rawStep.rationale ?? (isChanged ? "Modified by this diff" : "On the execution path"),
			isChanged,
			confidence,
		});
	}

	if (steps.length === 0) return null;

	// Use explicit entrypoints array if provided, otherwise first step
	let entrypoint: ChangedSymbol;
	if (raw.entrypoints && raw.entrypoints.length > 0) {
		const ep = raw.entrypoints[0];
		entrypoint = {
			name: ep.symbolName ?? steps[0].symbol.name,
			kind: "function",
			location: {
				filePath: ep.filePath ?? steps[0].symbol.location.filePath,
				line: ep.line ?? 1,
				isChanged: ep.isChanged ?? false,
			},
			qualifiedName: ep.symbolName ?? steps[0].symbol.name,
			confidence,
		};
	} else {
		entrypoint = steps[0].symbol;
	}

	return {
		id: behaviorId,
		name: raw.name,
		entrypointKind,
		entrypoint,
		steps,
		sideEffects: allSideEffects,
		touchedFiles: Array.from(touchedFiles),
		changedStepCount: changedCount,
		totalStepCount: steps.length,
		confidence,
	};
}

/**
 * Extract JSON from Claude's response text.
 * Handles: raw JSON, markdown-fenced JSON, JSON with surrounding text.
 */
function extractJson(text: string): string | null {
	// Try 1: Raw JSON (starts with {)
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		// Find the matching closing brace
		const end = findMatchingBrace(trimmed, 0);
		if (end > 0) return trimmed.slice(0, end + 1);
	}

	// Try 2: Markdown fenced JSON
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		const inner = fenceMatch[1].trim();
		if (inner.startsWith("{")) return inner;
	}

	// Try 3: Find first { and last } in the text
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return text.slice(firstBrace, lastBrace + 1);
	}

	return null;
}

function findMatchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escape = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\") { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function detectLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
		mjs: "javascript", cjs: "javascript", py: "python", sql: "sql",
	};
	return map[ext] ?? "text";
}

function emptyResult(
	sessionId: string,
	diffFingerprint: string,
	analysisTimeMs: number,
	warnings: string[],
): BehaviorAnalysis {
	return {
		sessionId,
		diffFingerprint,
		behaviors: [],
		orphanedSymbols: [],
		analysisTimeMs,
		createdAt: new Date().toISOString(),
		warnings,
	};
}
