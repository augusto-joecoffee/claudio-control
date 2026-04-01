import { discoverSessions } from "@/lib/discovery";
import { processIdleTransitions } from "@/lib/kanban-engine";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName } = await params;
    const decoded = decodeURIComponent(repoName);

    const sessions = await discoverSessions();
    const actions = await processIdleTransitions(decoded, sessions);

    return NextResponse.json({ ok: true, actions: actions.length });
  } catch (error) {
    console.error("Kanban tick failed:", error);
    return NextResponse.json({ error: "Tick failed" }, { status: 500 });
  }
}
