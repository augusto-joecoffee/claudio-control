import { loadKanbanState, saveKanbanState } from "@/lib/kanban-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  const { repoName } = await params;
  const state = await loadKanbanState(decodeURIComponent(repoName));
  return NextResponse.json(state);
}

export async function PUT(request: Request, { params }: { params: Promise<{ repoName: string }> }) {
  try {
    const { repoName } = await params;
    const body = await request.json();
    await saveKanbanState(decodeURIComponent(repoName), body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to save kanban state:", error);
    return NextResponse.json({ error: "Failed to save state" }, { status: 500 });
  }
}
