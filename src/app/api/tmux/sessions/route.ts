import { NextResponse } from "next/server";
import { listTmuxSessions } from "@/lib/terminal";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessions = await listTmuxSessions();
  return NextResponse.json({ sessions });
}
