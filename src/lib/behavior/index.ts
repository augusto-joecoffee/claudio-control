/**
 * Behavior analysis public API.
 * Delegates to the layered analysis pipeline.
 */

export { analyzeWithTypeScript as analyzeBehaviors } from "./analyzer";
export { invalidateProjectCache } from "./analyzer";
