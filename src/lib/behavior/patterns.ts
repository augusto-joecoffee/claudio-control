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
	// Job/worker files (*.job.ts, *.worker.ts, jobs/*, workers/*)
	{
		pathMatch: /\.(job|worker)\.(ts|js)$/,
		symbolMatch: /^(perform|prePerform|postPerform|execute|run|handle|process)$/,
		kind: "queue-consumer",
		confidence: "high",
	},
	// Cron files (crons/*, *.cron.ts)
	{
		pathMatch: /(\/crons?\/|\.cron\.)/,
		symbolMatch: /^(perform|prePerform|postPerform|execute|run|handle)$/,
		kind: "cron-job",
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
	// Test files — only top-level describe blocks, not individual functions
	{
		pathMatch: /\.(test|spec)\.(ts|js|tsx|jsx)$/,
		symbolMatch: /^describe$/,
		kind: "test-function",
		confidence: "high",
	},
	// Test files in __tests__ directories
	{
		pathMatch: /__tests__\//,
		symbolMatch: /^describe$/,
		kind: "test-function",
		confidence: "high",
	},
];

/** Code-pattern-based entrypoint detection rules (checked on function body).
 *  These are ONLY applied to symbols that are top-level exports or class methods,
 *  NOT to every random function body. */
export const ENTRYPOINT_CODE_PATTERNS: EntrypointCodePattern[] = [
	// Express/Koa/Hono route registration
	{ codeMatch: /\bapp\.(get|post|put|delete|patch|use)\s*\(/, kind: "api-route", confidence: "high" },
	{ codeMatch: /\brouter\.(get|post|put|delete|patch|use)\s*\(/, kind: "api-route", confidence: "high" },
	// Fastify
	{ codeMatch: /\bfastify\.(get|post|put|delete|patch)\s*\(/, kind: "api-route", confidence: "high" },
	// Queue consumers
	{ codeMatch: /\.process\s*\(\s*['"`]/, kind: "queue-consumer", confidence: "medium" },
	{ codeMatch: /\.consume\s*\(/, kind: "queue-consumer", confidence: "medium" },
	{ codeMatch: /createConsumer/, kind: "queue-consumer", confidence: "medium" },
	// CLI commands
	{ codeMatch: /\.command\s*\(\s*['"`]/, kind: "cli-command", confidence: "medium" },
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
	// Drizzle / Knex / raw SQL writes
	{ match: /\bdb\.(execute|insert|update|delete)\b/, kind: "db-write", confidence: "high", descriptionTemplate: "db.$1()" },
	{ match: /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i, kind: "db-write", confidence: "high", descriptionTemplate: "$1" },
	// Drizzle / Knex / raw SQL reads
	{ match: /\bdb\.(select|query)\b/, kind: "db-read", confidence: "medium", descriptionTemplate: "db.$1()" },
	// Generic ORM writes
	{ match: /\.(save|insert|destroy|remove)\s*\(/, kind: "db-write", confidence: "medium", descriptionTemplate: "$0" },
	// HTTP requests
	{ match: /\bfetch\s*\(/, kind: "http-request", confidence: "high", descriptionTemplate: "fetch()" },
	{ match: /\baxios\.(get|post|put|delete|patch|request)\b/, kind: "http-request", confidence: "high", descriptionTemplate: "axios.$1()" },
	{ match: /\bgot\s*\(/, kind: "http-request", confidence: "high", descriptionTemplate: "got()" },
	// Stripe API calls
	{ match: /\bstripe\w*\.\w+\.(create|update|del|list|retrieve)\b/, kind: "http-request", confidence: "high", descriptionTemplate: "$0" },
	{ match: /\bstripeClient\.\w+\.(create|update|del|list|retrieve)\b/, kind: "http-request", confidence: "high", descriptionTemplate: "$0" },
	// Queue/message publishing
	{ match: /\b(enqueueJob|enqueueSecondaryJob)\s*\(/, kind: "queue-publish", confidence: "high", descriptionTemplate: "$1()" },
	{ match: /\.(publish|dispatch|enqueue|addJob)\s*\(/, kind: "queue-publish", confidence: "medium", descriptionTemplate: "$0" },
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
	/** If true, this pattern requires being inside a class scope to match. */
	requiresClassScope?: boolean;
}

/** Patterns to detect symbol declarations in source files.
 *  Applied line-by-line. Order matters — first match wins.
 *
 *  IMPORTANT: The method pattern is intentionally strict — it only matches
 *  indented lines that have explicit access modifiers (public/private/protected/static/async)
 *  OR are inside a tracked class scope. This avoids matching chained method calls,
 *  ORM builder patterns, test framework calls, etc. */
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
	// export const foo = {  (object export like `export const calculateDailyLoyaltyFees = { prePerform, perform }`)
	{ match: /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*\{/, kind: "export", nameGroup: 1 },
	// Class methods with EXPLICIT access modifier: public async handleCreate( / private foo( / static bar(
	{ match: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/, kind: "method", nameGroup: 1 },
	{ match: /^\s+static\s+(?:async\s+)?(\w+)\s*\(/, kind: "method", nameGroup: 1 },
	// Class methods without access modifier — ONLY when inside a class scope
	{ match: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w[^{]*)?{/, kind: "method", nameGroup: 1, requiresClassScope: true },
	// Plain function declarations: async function foo( or function foo(
	{ match: /^(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
	// Top-level const foo = async ( or const foo = (  (NOT indented — avoids matching inside function bodies)
	{ match: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
	// Top-level const foo = async function
	{ match: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: "function", nameGroup: 1 },
	// export type / export interface
	{ match: /^export\s+(?:type|interface)\s+(\w+)/, kind: "type", nameGroup: 1 },
];

/** Names that should never be treated as symbols — they are language keywords,
 *  test framework globals, ORM/schema builder methods, SQL builder functions, etc. */
export const SYMBOL_SKIP_LIST = new Set([
	// Language
	"constructor", "if", "for", "while", "switch", "return", "catch", "try", "throw", "new",
	"else", "case", "break", "continue", "default", "do", "typeof", "instanceof", "void", "delete",
	"in", "of", "with", "yield", "await", "async", "super", "this",
	// Test framework
	"describe", "it", "test", "expect", "beforeEach", "afterEach", "beforeAll", "afterAll",
	"jest", "vi", "assert", "should", "mock", "spy", "stub", "sandbox",
	"mockAbortChecks", // common test helper
	// ORM / Schema builders (Drizzle, TypeORM, Knex, Sequelize, MikroORM)
	"check", "index", "unique", "foreignKey", "primaryKey", "references", "column",
	"serial", "integer", "varchar", "text", "boolean", "timestamp", "numeric", "decimal",
	"bigint", "smallint", "real", "json", "jsonb", "uuid", "date", "time", "interval",
	"createTable", "alterTable", "dropTable", "addColumn", "createIndex",
	"pgTable", "pgEnum", "mysqlTable", "sqliteTable",
	"Entity", "Column", "PrimaryColumn", "PrimaryGeneratedColumn", "ManyToOne", "OneToMany",
	"ManyToMany", "JoinColumn", "JoinTable", "Index", "Unique", "Check",
	// SQL builder functions (Drizzle, Knex)
	"eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "sql", "raw",
	"isNull", "isNotNull", "inArray", "notInArray", "between", "like", "ilike",
	"asc", "desc", "count", "sum", "avg", "min", "max",
	"COALESCE", "AND", "OR", "NOT", "VALUES", "SET",
	// Common non-function patterns
	"then", "catch", "finally", "resolve", "reject",
	"map", "filter", "reduce", "forEach", "find", "some", "every", "flat", "flatMap",
	"push", "pop", "shift", "unshift", "splice", "slice", "concat", "join", "split",
	"keys", "values", "entries", "has", "get", "set", "add", "clear",
	"toString", "valueOf", "toJSON", "toLocaleString",
	"log", "warn", "error", "info", "debug", "trace",
	"require", "module", "exports",
]);

/** File extensions that the analysis pipeline can process. */
export const ANALYZABLE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
