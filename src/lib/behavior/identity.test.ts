import { describe, expect, it } from "vitest";
import { buildFlowFingerprint, buildFlowKey, buildStepFingerprint, buildStepKey } from "./identity";

describe("behavior identity helpers", () => {
	it("builds stable step keys and fingerprints", () => {
		const stepKey = buildStepKey("src/foo.ts::calculateTotals");
		const first = buildStepFingerprint(stepKey, "function calculateTotals() {}", [{ start: 10, end: 12 }], true);
		const second = buildStepFingerprint(stepKey, "function calculateTotals() {}", [{ start: 10, end: 12 }], true);

		expect(stepKey).toBe("src/foo.ts::calculateTotals");
		expect(first).toBe(second);
	});

	it("changes the step fingerprint when the reviewable content changes", () => {
		const stepKey = buildStepKey("src/foo.ts::calculateTotals");
		const before = buildStepFingerprint(stepKey, "return subtotal;", [{ start: 10, end: 10 }], true);
		const after = buildStepFingerprint(stepKey, "return subtotal + tax;", [{ start: 10, end: 10 }], true);

		expect(before).not.toBe(after);
	});

	it("keeps the flow key stable but changes the fingerprint when a step fingerprint changes", () => {
		const entrypointKey = buildStepKey("src/app/api/orders/route.ts::POST");
		const primaryStepKey = buildStepKey("src/lib/orders.ts::calculateTotals");
		const stepKeys = [entrypointKey, primaryStepKey];

		const flowKey = buildFlowKey(entrypointKey, primaryStepKey, stepKeys);
		const firstFingerprint = buildFlowFingerprint(entrypointKey, [
			{ key: entrypointKey, fingerprint: "entry-v1", isChanged: false },
			{ key: primaryStepKey, fingerprint: "totals-v1", isChanged: true },
		]);
		const secondFingerprint = buildFlowFingerprint(entrypointKey, [
			{ key: entrypointKey, fingerprint: "entry-v1", isChanged: false },
			{ key: primaryStepKey, fingerprint: "totals-v2", isChanged: true },
		]);

		expect(flowKey).toBe(buildFlowKey(entrypointKey, primaryStepKey, stepKeys));
		expect(firstFingerprint).not.toBe(secondFingerprint);
	});
});
