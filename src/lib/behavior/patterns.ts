/**
 * Framework-specific pattern definitions for entrypoint detection and side-effect matching.
 * Data-driven — add new frameworks by adding entries to these arrays.
 */

import type { EntrypointKind, SideEffectKind, ConfidenceLevel } from "../types";

// ── Entrypoint Patterns ──

export interface EntrypointFilePattern {
	/** Glob-like pattern matched against the file path (uses simple string matching). */
	pathMatch: RegExp;
	/** Symbol name pattern (if null, any exported symbol in the file qualifies). */
	symbolMatch?: RegExp;
	kind: EntrypointKind;
	confidence: ConfidenceLevel;
}

export interface EntrypointCodePattern {
	/** Regex matched against the function body or surrounding context. */
	codeMatch: RegExp;
	kind: EntrypointKind;
	confidence: ConfidenceLevel;
}

/** File-path-based entrypoint detection rules (checked in order, first match wins). */
export const ENTRYPOINT_FILE_PATTERNS: EntrypointFilePattern[] = [
	// Next.js App Router route handlers
	{
		pathMatch: /\/app\/.*\/route\.(ts|js|tsx|jsx)$/,
		symbolMatch: /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/,
		kind: "api-route",
		confidence: "high",
	},
	// Next.js Pages API routes
	{
		pathMatch: /\/pages\/api\//,
		kind: "api-route",
		confidence: "high",
	},
	// Next.js App Router pages
	{
		pathMatch: /\/app\/.*\/page\.(tsx|jsx)$/,
		kind: "react-component",
		confidence: "high",
	},
	// Next.js Pages Router pages
	{
		pathMatch: /\/pages\/(?!api\/|_)[^/]+\.(tsx|jsx)$/,
		kind: "react-component",
		confidence: "medium",
	},
	// Test files
	{
		pathMatch: /\.(test|spec)\.(ts|js|tsx|jsx)$/,
		kind: "test-function",
		confidence: "high",
	},
	// Test files in __tests__ directories
	{
		pathMatch: /__tests__\//,
		kind: "test-function",
		confidence: "high",
	},
];

/** Code-pattern-based entrypoint detection rules (checked on function body). */
export const ENTRYPOINT_CODE_PATTERNS: EntrypointCodePattern[] = [
	// Express/Koa/Hono route registration
	{ codeMatch: /\bapp\.(get|post|put|delete|patch|use)\s*\(/, kind: "api-route", confidence: "high" },
	{ codeMatch: /\brouter\.(get|post|put|delete|patch|use)\s*\(/, kind: "api-route", confidence: "high" },
	// Fastify
	{ codeMatch: /\bfastify\.(get|post|put|delete|patch)\s*\(/, kind: "api-route", confidence: "high" },
	// Event handlers
	{ codeMatch: /\.on\s*\(\s*['"`]/, kind: "event-handler", confidence: "medium" },
	{ codeMatch: /addEventListener\s*\(/, kind: "event-handler", confidence: "medium" },
	{ codeMatch: /\.subscribe\s*\(/, kind: "event-handler", confidence: "medium" },
	// Queue consumers
	{ codeMatch: /\.process\s*\(\s*['"`]/, kind: "queue-consumer", confidence: "medium" },
	{ codeMatch: /\.consume\s*\(/, kind: "queue-consumer", confidence: "medium" },
	{ codeMatch: /createConsumer/, kind: "queue-consumer", confidence: "medium" },
	// CLI commands
	{ codeMatch: /\.command\s*\(\s*['"`]/, kind: "cli-command", confidence: "medium" },
	// Cron/scheduled
	{ codeMatch: /\bcron\b|\bschedule\s*\(|\bsetInterval\s*\(/, kind: "cron-job", confidence: "low" },
	// Test functions
	{ codeMatch: /\b(describe|it|test)\s*\(\s*['"`]/, kind: "test-function", confidence: "high" },
];

// ── Side-Effect Patterns ──

export interface SideEffectPattern {
	match: RegExp;
	kind: SideEffectKind;
	confidence: ConfidenceLevel;
	/** Template for description — $0 is full match, $1+ are capture groups. */
	descriptionTemplate: string;
}

export const SIDE_EFFECT_PATTERNS: SideEffectPattern[] = [
	// Prisma writes
	{ match: /prisma\.(\w+)\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\b/, kind: "db-write", confidence: "high", descriptionTemplate: "prisma.$1.$2()" },
	// Prisma reads
	{ match: /prisma\.(\w+)\.(findUnique|findFirst|findMany|count|aggregate|groupBy)\b/, kind: "db-read", confidence: "medium", descriptionTemplate: "prisma.$1.$2()" },
	// Generic ORM writes
	{ match: /\.(save|insert|destroy|remove)\s*\(/, kind: "db-write", confidence: "medium", descriptionTemplate: "$0" },
	// HTTP requests
	{ match: /\bfetch\s*\(/, kind: "http-request", confidence: "high", descriptionTemplate: "fetch()" },
	{ match: /\baxios\.(get|post|put|delete|patch|request)\b/, kind: "http-request", confidence: "high", descriptionTemplate: "axios.$1()" },
	{ match: /\bgot\s*\(/, kind: "http-request", confidence: "high", descriptionTemplate: "got()" },
	// Queue/message publishing
	{ match: /\.(publish|dispatch|enqueue|addJob)\s*\(/, kind: "queue-publish", confidence: "medium", descriptionTemplate: "$0" },
	{ match: /\.add\s*\(\s*['"`]/, kind: "queue-publish", confidence: "low", descriptionTemplate: "queue.add()" },
	// Cache writes
	{ match: /redis\.(set|hset|lpush|rpush|sadd)\b/, kind: "cache-write", confidence: "medium", descriptionTemplate: "redis.$1()" },
	{ match: /cache\.(set|put)\s*\(/, kind: "cache-write", confidence: "medium", descriptionTemplate: "cache.$1()" },
	// Cache reads
	{ match: /redis\.(get|hget|lrange|smembers)\b/, kind: "cache-read", confidence: "low", descriptionTemplate: "redis.$1()" },
	{ match: /cache\.get\s*\(/, kind: "cache-read", confidence: "low", descriptionTemplate: "cache.get()" },
	// Event emission
	{ match: /\.emit\s*\(\s*['"`]([^'"`]+)/, kind: "event-emit", confidence: "medium", descriptionTemplate: "emit('$1')" },
	// File I/O writes
	{ match: /\b(writeFile|appendFile|createWriteStream)\b/, kind: "file-io", confidence: "high", descriptionTemplate: "$1()" },
	{ match: /\bfs\.(write|writeFile|appendFile|mkdir|rmdir|unlink)\b/, kind: "file-io", confidence: "high", descriptionTemplate: "fs.$1()" },
	// Process exit
	{ match: /\bprocess\.exit\b/, kind: "process-exit", confidence: "high", descriptionTemplate: "process.exit()" },
];

// ── Symbol Declaration Patterns ──

export interface SymbolPattern {
	match: RegExp;
	kind: "function" | "method" | "class" | "variable" | "type" | "export";
	/** Capture group index for the symbol name. */
	nameGroup: number;
}

/** Patterns to detect symbol declarations in source files.
 *  Applied line-by-line. Order matters — first match wins. */
export const SYMBOL_DECLARATION_PATTERNS: SymbolPattern[] = [
	// export async function foo(
	{ match: /^export\s+(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
	// export default async function foo(
	{ match: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
	// export class Foo
	{ match: /^export\s+(?:default\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
	// export const foo = async (  or  export const foo = (
	{ match: /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
	// export const foo = async function  or  export const foo = function
	{ match: /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: "function", nameGroup: 1 },
	// Class methods: public async handleCreate( or handleCreate(
	{ match: /^\s+(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\(/, kind: "method", nameGroup: 1 },
	// Plain function declarations: async function foo( or function foo(
	{ match: /^(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
	// const foo = async ( or const foo = (
	{ match: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
	// const foo = async function or const foo = function
	{ match: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: "function", nameGroup: 1 },
	// export type / export interface
	{ match: /^export\s+(?:type|interface)\s+(\w+)/, kind: "type", nameGroup: 1 },
];

/** File extensions that the analysis pipeline can process. */
export const ANALYZABLE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
