import type { SymbolId } from "./graph-types";
import type { ExecutionStep } from "../types";

type ChangedRange = { start: number; end: number };

function hashString(input: string): string {
	let h1 = 0xdeadbeef ^ input.length;
	let h2 = 0x41c6ce57 ^ input.length;

	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).slice(0, 16);
}

function serializeRanges(ranges: ChangedRange[] = []): string {
	return ranges
		.map((range) => `${range.start}-${range.end}`)
		.sort()
		.join(",");
}

export function buildStepKey(symbolId: SymbolId): string {
	return symbolId;
}

export function buildStepFingerprint(
	symbolId: SymbolId,
	sourceText: string,
	changedRanges: ChangedRange[] = [],
	isChanged: boolean,
): string {
	return hashString(`${symbolId}\n${isChanged ? "changed" : "unchanged"}\n${serializeRanges(changedRanges)}\n${sourceText}`);
}

export function buildFlowKey(entrypointKey: string, primaryStepKey: string, stepKeys: string[]): string {
	return `${entrypointKey}>>${primaryStepKey}>>${hashString(stepKeys.join("\n"))}`;
}

export function buildFlowFingerprint(
	entrypointKey: string,
	stepEntries: Array<Pick<ExecutionStep, "key" | "fingerprint" | "isChanged">>,
): string {
	return hashString(
		[
			entrypointKey,
			...stepEntries.map((step) => `${step.key}:${step.fingerprint}:${step.isChanged ? "1" : "0"}`),
		].join("\n"),
	);
}

export function hashRangesAndContent(ranges: ChangedRange[] = [], content: string): string {
	return hashString(`${serializeRanges(ranges)}\n${content}`);
}
