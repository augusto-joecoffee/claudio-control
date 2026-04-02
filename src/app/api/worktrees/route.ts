import { NextResponse } from "next/server";
import { getAllWorktrees } from "@/lib/git-info";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repoPath");

  if (!repoPath) {
    return NextResponse.json({ error: "Missing repoPath" }, { status: 400 });
  }

  const worktrees = await getAllWorktrees(repoPath);
  return NextResponse.json({ worktrees });
}
