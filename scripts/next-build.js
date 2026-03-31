// Wrapper for `next build` that works around a Next.js 16 bug where
// prerendering /_global-error crashes with a useContext error.
//
// Strategy:
// 1. Run compile step (produces standalone server + compiled assets)
// 2. Run generate step (produces prerendered HTML pages)
//    - If generate fails (due to _global-error bug), that's OK —
//      all our pages are dynamic (server-rendered) anyway.

const { execSync } = require("child_process");

console.log("Step 1: Compiling...");
execSync("npx next build --experimental-build-mode compile", {
  stdio: "inherit",
  env: { ...process.env },
});

console.log("\nStep 2: Generating static pages...");
try {
  execSync("npx next build --experimental-build-mode generate", {
    stdio: "inherit",
    env: { ...process.env },
  });
} catch {
  console.log("\n⚠  Static page generation failed (expected: Next.js 16 _global-error bug).");
  console.log("   All pages are server-rendered on demand — this is fine for Electron.\n");
}
