import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { analyzeWithTypeScript, invalidateProjectCache } from "./analyzer";

async function makeRepo(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "behavior-analyzer-"));
	await Promise.all(
		Object.entries(files).map(async ([relativePath, content]) => {
			const fullPath = join(cwd, relativePath);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, content);
		}),
	);
	return cwd;
}

function addedFileDiff(filePath: string, content: string): string {
	const lines = content.split("\n").map((line) => `+${line}`).join("\n");
	const lineCount = content.split("\n").length;
	return [
		`diff --git a/${filePath} b/${filePath}`,
		"new file mode 100644",
		"index 0000000..1111111",
		"--- /dev/null",
		`+++ b/${filePath}`,
		`@@ -0,0 +1,${lineCount} @@`,
		lines,
		"",
	].join("\n");
}

const tempDirs: string[] = [];

afterEach(async () => {
	invalidateProjectCache();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("analyzeWithTypeScript", () => {
	it("indexes wrapped handler exports like postEndpoint([... async () => {}])", async () => {
		const publishSource = [
			"const postEndpoint = (...args: unknown[]) => args;",
			"",
			"export const publishStore = postEndpoint([",
			"  async (req: { body: { storeId: string } }) => {",
			"    return req.body.storeId;",
			"  },",
			"]);",
			"",
		].join("\n");

		const cwd = await makeRepo({
			"tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "CommonJS" }, include: ["src/**/*.ts"] }),
			"src/api/publish.ts": publishSource,
		});
		tempDirs.push(cwd);

		const diff = addedFileDiff("src/api/publish.ts", publishSource);
		const analysis = await analyzeWithTypeScript("session", diff, cwd, "fp-1");

		expect(analysis.behaviors.length).toBeGreaterThan(0);
		expect(analysis.behaviors[0].steps.some((step) => step.symbol.name === "publishStore")).toBe(true);
		expect(analysis.warnings).not.toContain(expect.stringContaining("No changed symbols could be anchored"));
	});

	it("loads changed files even when the selected tsconfig excludes them", async () => {
		const testSource = [
			"export const publishStoreSpec = async () => {",
			"  return 'ok';",
			"};",
			"",
		].join("\n");

		const cwd = await makeRepo({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ESNext", module: "CommonJS" },
				include: ["src/**/*.ts"],
				exclude: ["src/tests/**/*.ts"],
			}),
			"src/tests/publish.spec.ts": testSource,
		});
		tempDirs.push(cwd);

		const diff = addedFileDiff("src/tests/publish.spec.ts", testSource);
		const analysis = await analyzeWithTypeScript("session", diff, cwd, "fp-2");

		expect(analysis.behaviors.length).toBeGreaterThan(0);
		expect(analysis.behaviors[0].entrypointKind).toBe("test-function");
		expect(analysis.warnings).not.toContain(expect.stringContaining("Could not load source file"));
	});

	it("creates a self-rooted flow for a wrapped exported handler without a recognized entrypoint", async () => {
		const handlerSource = [
			"const wrapHandler = (...args: unknown[]) => args;",
			"",
			"export const convertSquareCustomer = wrapHandler([",
			"  async (_ctx: unknown, response: unknown) => {",
			"    return response;",
			"  },",
			"]);",
			"",
		].join("\n");

		const cwd = await makeRepo({
			"tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "CommonJS" }, include: ["src/**/*.ts"] }),
			"src/handlers/convertSquareCustomer.ts": handlerSource,
		});
		tempDirs.push(cwd);

		const diff = addedFileDiff("src/handlers/convertSquareCustomer.ts", handlerSource);
		const analysis = await analyzeWithTypeScript("session", diff, cwd, "fp-3");

		expect(analysis.orphanedSymbols).toEqual([]);
		expect(analysis.behaviors.length).toBeGreaterThan(0);
		expect(analysis.behaviors[0].entrypointKind).toBe("exported-function");
		expect(analysis.behaviors[0].steps.some((step) => step.symbol.name === "convertSquareCustomer")).toBe(true);
	});

	it("roots changed utilities through callers imported from barrel exports", async () => {
		const joeBalanceSource = [
			"export const getUploadFees = async () => {",
			"  return 42;",
			"};",
			"",
		].join("\n");
		const uploadSource = [
			"import { getUploadFees } from '@/utils';",
			"const postEndpoint = (...args: unknown[]) => args;",
			"",
			"export const uploadPosJoebucks = postEndpoint([",
			"  async () => {",
			"    return getUploadFees();",
			"  },",
			"]);",
			"",
		].join("\n");

		const cwd = await makeRepo({
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					target: "ESNext",
					module: "CommonJS",
					baseUrl: ".",
					paths: { "@/*": ["src/*"] },
				},
				include: ["src/**/*.ts"],
			}),
			"src/utils/index.ts": "export * from './joeBalance';\n",
			"src/utils/joeBalance.ts": joeBalanceSource,
			"src/api/upload.ts": uploadSource,
		});
		tempDirs.push(cwd);

		const diff = addedFileDiff("src/utils/joeBalance.ts", joeBalanceSource);
		const analysis = await analyzeWithTypeScript("session", diff, cwd, "fp-4");

		expect(
			analysis.behaviors.some((behavior) =>
				behavior.entrypointKind === "api-route" &&
				behavior.steps.some((step) => step.symbol.name === "getUploadFees"),
			),
		).toBe(true);
		expect(
			analysis.behaviors.some((behavior) =>
				behavior.entrypoint.location.filePath === "src/utils/joeBalance.ts" &&
				behavior.entrypoint.name === "getUploadFees",
			),
		).toBe(false);
	});

	it("suppresses orphaned export wrapper symbols when the same file already has traced changed flow steps", async () => {
		const jobSource = [
			"const prePerform = async () => {",
			"  return 'pre';",
			"};",
			"",
			"const perform = async () => {",
			"  return 'perform';",
			"};",
			"",
			"const postPerform = async () => {",
			"  return 'post';",
			"};",
			"",
			"export const distributeLoyaltyFee = {",
			"  prePerform,",
			"  perform,",
			"  postPerform,",
			"};",
			"",
		].join("\n");

		const cwd = await makeRepo({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ESNext", module: "CommonJS" },
				include: ["src/**/*.ts"],
			}),
			"src/jobs/distributeLoyaltyFee.job.ts": jobSource,
		});
		tempDirs.push(cwd);

		const diff = addedFileDiff("src/jobs/distributeLoyaltyFee.job.ts", jobSource);
		const analysis = await analyzeWithTypeScript("session", diff, cwd, "fp-5");

		expect(analysis.behaviors.some((behavior) => behavior.touchedFiles.includes("src/jobs/distributeLoyaltyFee.job.ts"))).toBe(true);
		expect(analysis.orphanedSymbols.some((symbol) => symbol.name === "distributeLoyaltyFee")).toBe(false);
	});
});
