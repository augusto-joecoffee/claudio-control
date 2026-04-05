/**
 * Format the behavior analysis prompt sent to the Claude session.
 *
 * IMPORTANT: The prompt must be SHORT-ISH because it's sent via tmux send-keys.
 * We tell Claude to run `git diff` itself — it already has the repo and tools.
 */

import { randomUUID } from "crypto";

export interface BehaviorPromptResult {
	analysisId: string;
	prompt: string;
}

export function formatBehaviorPrompt(mergeBase: string): BehaviorPromptResult {
	const analysisId = randomUUID();

	const prompt = `[Behavior Analysis] [id:${analysisId}]

You are analyzing a code diff. Produce a JSON object describing every behavioral flow the diff introduces or modifies, with every function call as its own step.

Workflow:
1. Run \`git diff ${mergeBase} --unified=3\` to get the changed files and hunks.
2. Identify changed symbols and derive behavior entrypoints: scheduled tasks, API/web handlers, webhooks, queue/job handlers, CLI commands, background workers, event subscribers.
3. For each entrypoint, trace the DOWNSTREAM call chain by reading the actual source files.
4. Every function invocation must be its own step. Do not collapse multiple calls into one step.
5. For each function in the chain, read its source body and confirm: what it does, what it calls next, and whether it performs side effects.
6. Mark \`"isChanged": true\` only if that function was added or modified in the diff.
7. Group related behavior into a single flow when it is one end-to-end execution path.
8. Do not speculate. Only include steps you can justify from the diff and source reads.

Rules:
- Do NOT collapse helper calls. If A calls B which hits the DB, that is 2 steps.
- Include side effects on the step where they occur.
- Start from the diff, not from manually outlining files.

Return ONLY a JSON object. No markdown fences. No explanation before or after.

{"flows":[{"name":"string","entrypointKind":"api-route|queue-consumer|cron-job|event-handler|exported-function","confidence":"high|medium|low","entrypoints":[{"filePath":"string","symbolName":"string","line":0,"isChanged":true}],"steps":[{"filePath":"string","symbolName":"string","line":0,"isChanged":true,"rationale":"string","sideEffects":[{"kind":"db-write|db-read|http-request|queue-publish|event-emit|external-sdk|file-io|cache-read|cache-write","description":"string"}]}]}]}`;

	return { analysisId, prompt };
}
