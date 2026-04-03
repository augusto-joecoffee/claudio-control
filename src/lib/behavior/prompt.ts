/**
 * Format the behavior analysis prompt sent to the Claude session.
 *
 * IMPORTANT: The prompt must be SHORT because it's sent via tmux send-keys
 * which can't handle 70K+ character pastes. Instead of embedding the diff,
 * we tell Claude to run `git diff` itself — it already has the repo.
 */

import { randomUUID } from "crypto";

export interface BehaviorPromptResult {
	analysisId: string;
	prompt: string;
}

/**
 * Build a short behavior analysis prompt. Tells Claude to read the diff
 * itself using git commands, then return structured JSON.
 */
export function formatBehaviorPrompt(mergeBase: string): BehaviorPromptResult {
	const analysisId = randomUUID();

	const prompt = `[Behavior Analysis] [id:${analysisId}]

Run \`git diff ${mergeBase} --unified=3\` to see the changes in this branch, then analyze the diff to identify the distinct behavioral flows this PR introduces or modifies.

For each flow, trace the COMPLETE execution path from entrypoint through every function call in order. Read the actual source files as needed to understand the call chains.

Return ONLY a JSON object (no markdown fences, no explanation before or after) with this structure:
{"flows":[{"name":"...","entrypointKind":"api-route|queue-consumer|cron-job|event-handler|exported-function","confidence":"high|medium|low","steps":[{"filePath":"...","symbolName":"...","line":0,"isChanged":true,"rationale":"...","sideEffects":[{"kind":"db-write|db-read|http-request|queue-publish|event-emit","description":"..."}]}]}]}

Guidelines:
- Group related changes into single flows (e.g. all loyalty fee changes = one flow)
- Start each flow from its entrypoint (cron, API route, job, event handler) and walk through every meaningful function call in execution order
- Include unchanged functions ON THE PATH if they help understand the flow
- Do NOT create separate flows for every caller of a changed utility
- Focus on what the PR DOES, not what it affects
- Be specific about side effects (name the table, endpoint, queue)`;

	return { analysisId, prompt };
}
