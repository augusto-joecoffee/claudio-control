import type { ChangedBehavior, ChangedSymbol, ExecutionStep } from "../types";
import { buildFlowFingerprint, buildStepFingerprint } from "./identity";

const ORPHAN_BEHAVIOR_PREFIX = "orphan:";

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
	mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
	rs: "rust", go: "go", java: "java", kt: "kotlin", sql: "sql",
	json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
};

function detectLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return EXT_TO_LANG[ext] ?? "text";
}

function buildOrphanStepKey(symbol: ChangedSymbol): string {
	return `${symbol.location.filePath}::${symbol.qualifiedName ?? symbol.name}`;
}

export function buildOrphanBehaviorId(symbol: ChangedSymbol): string {
	return `${ORPHAN_BEHAVIOR_PREFIX}${encodeURIComponent(buildOrphanStepKey(symbol))}:${symbol.location.line}`;
}

export function isOrphanBehaviorId(id: string | null | undefined): boolean {
	return !!id && id.startsWith(ORPHAN_BEHAVIOR_PREFIX);
}

export function makeOrphanBehavior(
	symbol: ChangedSymbol,
	options?: { content?: string; startLine?: number; endLine?: number },
): ChangedBehavior {
	const stepKey = buildOrphanStepKey(symbol);
	const startLine = Math.max(1, options?.startLine ?? symbol.location.line ?? 1);
	const endLine = Math.max(startLine, options?.endLine ?? symbol.location.endLine ?? startLine);
	const changedRanges = [{ start: startLine, end: endLine }];

	const step: ExecutionStep = {
		id: stepKey,
		key: stepKey,
		fingerprint: buildStepFingerprint(
			stepKey,
			options?.content ?? `${symbol.name}\n${startLine}-${endLine}`,
			changedRanges,
			true,
		),
		order: 0,
		symbol: {
			...symbol,
			location: {
				...symbol.location,
				line: startLine,
				endLine,
				isChanged: true,
			},
		},
		snippet: {
			filePath: symbol.location.filePath,
			startLine,
			endLine,
			content: options?.content,
			language: detectLang(symbol.location.filePath),
		},
		sideEffects: [],
		callsTo: [],
		rationale: "Changed code without traced flow",
		isChanged: true,
		changedRanges,
		confidence: symbol.confidence,
	};

	return {
		id: buildOrphanBehaviorId(symbol),
		key: buildOrphanBehaviorId(symbol),
		fingerprint: buildFlowFingerprint(stepKey, [{ key: step.key, fingerprint: step.fingerprint, isChanged: true }]),
		name: `No flow: ${symbol.qualifiedName ?? symbol.name}`,
		reviewCategory: "modified",
		entrypointKind: "unknown",
		entrypoint: step.symbol,
		steps: [step],
		sideEffects: [],
		touchedFiles: [symbol.location.filePath],
		changedStepCount: 1,
		totalStepCount: 1,
		confidence: symbol.confidence,
	};
}
