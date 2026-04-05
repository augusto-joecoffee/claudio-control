import { describe, expect, it } from "vitest";
import type { ChangedSymbol } from "../types";
import { buildOrphanBehaviorId, isOrphanBehaviorId, makeOrphanBehavior } from "./orphaned";

function makeSymbol(overrides: Partial<ChangedSymbol> = {}): ChangedSymbol {
	return {
		name: "calculateDailyLoyaltyFees",
		kind: "function",
		location: {
			filePath: "src/jobs/crons/calculateDailyLoyaltyFees.job.ts",
			line: 64,
			endLine: 67,
			isChanged: true,
		},
		qualifiedName: "calculateDailyLoyaltyFees",
		confidence: "high",
		...overrides,
	};
}

describe("orphaned behavior helpers", () => {
	it("builds a stable orphan behavior id", () => {
		const symbol = makeSymbol();
		const id = buildOrphanBehaviorId(symbol);

		expect(isOrphanBehaviorId(id)).toBe(true);
		expect(id).toContain("orphan:");
		expect(id).toContain(":64");
	});

	it("creates a synthetic one-step behavior for viewing untraced changes", () => {
		const symbol = makeSymbol();
		const behavior = makeOrphanBehavior(symbol, {
			content: "export const calculateDailyLoyaltyFees = async () => {};",
		});

		expect(behavior.id).toBe(buildOrphanBehaviorId(symbol));
		expect(behavior.name).toBe("No flow: calculateDailyLoyaltyFees");
		expect(behavior.steps).toHaveLength(1);
		expect(behavior.steps[0]?.isChanged).toBe(true);
		expect(behavior.steps[0]?.snippet.content).toContain("calculateDailyLoyaltyFees");
	});
});
