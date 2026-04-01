import { NextResponse } from "next/server";
import { discoverSessions } from "@/lib/discovery";
import { areHooksInstalled, ensureHooksInstalled } from "@/lib/hooks-installer";
import { resolveRepoIds } from "@/lib/repo-registry";

export const dynamic = "force-dynamic";

let hookInstallAttempted = false;

export async function GET() {
  try {
    if (!hookInstallAttempted) {
      hookInstallAttempted = true;
      await ensureHooksInstalled();
    }

    const sessions = await discoverSessions();

    // Resolve stable repo IDs for each unique repo path
    const repoPaths = [...new Set(sessions.map((s) => s.parentRepo || s.workingDirectory))];
    const repoIds = await resolveRepoIds(repoPaths);

    return NextResponse.json({ sessions, hooksActive: areHooksInstalled(), repoIds });
  } catch (error) {
    console.error("Failed to discover sessions:", error);
    return NextResponse.json({ sessions: [], hooksActive: false, repoIds: {}, error: "Discovery failed" }, { status: 500 });
  }
}
