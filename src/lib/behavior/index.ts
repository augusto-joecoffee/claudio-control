/**
 * Behavior analysis orchestrator.
 * Delegates to the ts-morph-based analyzer for accurate, compiler-backed
 * call graph resolution and symbol extraction.
 */

export { analyzeWithTypeScript as analyzeBehaviors } from "./ts-analyzer";
export { invalidateProjectCache } from "./ts-analyzer";
