/**
 * Format the behavior analysis prompt sent to the Claude session.
 * Uses the same [id:xxx] tagging mechanism as review comments
 * so we can match the response in the JSONL.
 */

import { randomUUID } from "crypto";

export interface BehaviorPromptResult {
	/** Unique ID embedded in the prompt for response matching. */
	analysisId: string;
	/** The full prompt text to send to the Claude session. */
	prompt: string;
}

/**
 * Build the behavior analysis prompt. Includes the raw diff and instructions
 * for Claude to return structured JSON matching our flow schema.
 */
export function formatBehaviorPrompt(rawDiff: string): BehaviorPromptResult {
	const analysisId = randomUUID();

	// Truncate very large diffs to avoid overwhelming the context
	const maxDiffLength = 100_000;
	const truncatedDiff = rawDiff.length > maxDiffLength
		? rawDiff.slice(0, maxDiffLength) + "\n\n... [diff truncated, showing first 100K characters] ..."
		: rawDiff;

	const prompt = `[Behavior Analysis] [id:${analysisId}]

Analyze this code diff and identify the distinct behavioral flows it introduces or modifies.

For each flow, provide:
- name: human-readable name (e.g., "Daily loyalty fee calculation cron", "Company pricing update")
- entrypointKind: one of "api-route", "queue-consumer", "cron-job", "event-handler", "exported-function", "react-component", "test-function"
- steps: ordered array of execution steps, each with:
  - filePath: relative file path
  - symbolName: function/method name
  - line: approximate start line number
  - isChanged: whether this code was modified in the diff
  - rationale: why this step matters ("Entry point", "Modified by this diff", "Calls modified function", "Downstream DB write", etc.)
  - sideEffects: array of { kind, description } where kind is one of: "db-write", "db-read", "http-request", "queue-publish", "cache-write", "cache-read", "event-emit", "file-io", "process-exit"
- confidence: "high", "medium", or "low"

IMPORTANT GUIDELINES:
- Trace COMPLETE execution flows, not just individual changed functions
- Start from the entrypoint (cron job, API route, event handler, queue consumer) and walk through every meaningful function call in execution order
- Include unchanged functions that are ON THE PATH if they help the reviewer understand the flow
- Group related changes into single flows (e.g., all loyalty fee changes = one flow, not separate flows per file)
- Do NOT create a separate flow for every function that happens to call a changed utility — focus on what the PR DOES, not what it AFFECTS
- If a utility function was changed and many callers use it, mention the utility change as ONE flow and note the affected callers in the rationale, don't create 40 separate flows
- Order steps in actual execution order within each flow
- Be specific about side effects — name the DB table, the HTTP endpoint, the queue name when visible in the code

Return ONLY a JSON object with this exact structure (no markdown fences, no explanation, no text before or after):
{"flows":[{"name":"...","entrypointKind":"...","confidence":"high","steps":[{"filePath":"...","symbolName":"...","line":0,"isChanged":true,"rationale":"...","sideEffects":[{"kind":"...","description":"..."}]}]}]}

Here is the diff:

${truncatedDiff}`;

	return { analysisId, prompt };
}
