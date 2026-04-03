import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Lightweight config endpoint — just returns the config JSON.
 * Unlike /api/settings, this does NOT check installed apps (which spawns
 * dozens of child processes). Use this when you only need config values.
 */
export async function GET() {
  try {
    const config = await loadConfig();
    return NextResponse.json({ config });
  } catch {
    return NextResponse.json({ config: null }, { status: 500 });
  }
}
