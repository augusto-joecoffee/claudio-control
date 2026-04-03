"use client";

import { memo } from "react";
import type { SideEffectKind } from "@/lib/types";

const BADGE_CONFIG: Record<SideEffectKind, { label: string; borderColor: string; bgColor: string; textColor: string }> = {
	"db-write": { label: "DB Write", borderColor: "border-amber-500/50", bgColor: "bg-amber-500/10", textColor: "text-amber-400" },
	"db-read": { label: "DB Read", borderColor: "border-amber-500/30", bgColor: "bg-amber-500/5", textColor: "text-amber-400/70" },
	"http-request": { label: "HTTP", borderColor: "border-blue-500/50", bgColor: "bg-blue-500/10", textColor: "text-blue-400" },
	"queue-publish": { label: "Queue", borderColor: "border-violet-500/50", bgColor: "bg-violet-500/10", textColor: "text-violet-400" },
	"cache-write": { label: "Cache Write", borderColor: "border-cyan-500/50", bgColor: "bg-cyan-500/10", textColor: "text-cyan-400" },
	"cache-read": { label: "Cache Read", borderColor: "border-cyan-500/30", bgColor: "bg-cyan-500/5", textColor: "text-cyan-400/70" },
	"event-emit": { label: "Event", borderColor: "border-emerald-500/50", bgColor: "bg-emerald-500/10", textColor: "text-emerald-400" },
	"file-io": { label: "File I/O", borderColor: "border-zinc-500/50", bgColor: "bg-zinc-500/10", textColor: "text-zinc-400" },
	"process-exit": { label: "Exit", borderColor: "border-red-500/50", bgColor: "bg-red-500/10", textColor: "text-red-400" },
};

export const SideEffectBadge = memo(function SideEffectBadge({
	kind,
	description,
	compact,
}: {
	kind: SideEffectKind;
	description?: string;
	compact?: boolean;
}) {
	const config = BADGE_CONFIG[kind];
	return (
		<span
			className={`inline-flex items-center gap-1 rounded border text-[10px] ${config.borderColor} ${config.bgColor} ${config.textColor} ${
				compact ? "px-1 py-0" : "px-1.5 py-0.5"
			}`}
			title={description}
		>
			{config.label}
		</span>
	);
});
