"use client";

import { memo } from "react";
import type { ConfidenceLevel } from "@/lib/types";

const CONFIDENCE_CONFIG: Record<ConfidenceLevel, { label: string; color: string; dotColor: string }> = {
	high: { label: "high confidence", color: "text-emerald-500/60", dotColor: "bg-emerald-500" },
	medium: { label: "~approximate", color: "text-amber-500/60", dotColor: "bg-amber-500" },
	low: { label: "uncertain", color: "text-red-500/60", dotColor: "bg-red-500" },
};

export const ConfidenceIndicator = memo(function ConfidenceIndicator({
	level,
	showLabel,
}: {
	level: ConfidenceLevel;
	showLabel?: boolean;
}) {
	const config = CONFIDENCE_CONFIG[level];
	// Only show for medium/low — high confidence needs no annotation
	if (level === "high" && !showLabel) return null;

	return (
		<span className={`inline-flex items-center gap-1 text-[10px] ${config.color}`}>
			<span className={`w-1.5 h-1.5 rounded-full ${config.dotColor} opacity-60`} />
			{(showLabel || level !== "high") && config.label}
		</span>
	);
});

export const ConfidenceDots = memo(function ConfidenceDots({ level }: { level: ConfidenceLevel }) {
	const filled = level === "high" ? 3 : level === "medium" ? 2 : 1;
	const config = CONFIDENCE_CONFIG[level];
	return (
		<span className="inline-flex items-center gap-0.5" title={config.label}>
			{[0, 1, 2].map((i) => (
				<span
					key={i}
					className={`w-1 h-1 rounded-full ${i < filled ? config.dotColor : "bg-zinc-700"}`}
				/>
			))}
		</span>
	);
});
