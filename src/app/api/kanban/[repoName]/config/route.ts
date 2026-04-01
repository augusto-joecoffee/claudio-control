import { loadKanbanConfig, saveKanbanConfig } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  const { repoName } = await params;
  const config = await loadKanbanConfig(decodeURIComponent(repoName));
  return NextResponse.json(config);
}

export async function PUT(request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName } = await params;
    const body = await request.json();
    await saveKanbanConfig(decodeURIComponent(repoName), body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to save kanban config:", error);
    return NextResponse.json({ error: "Failed to save config" }, { status: 500 });
  }
}
