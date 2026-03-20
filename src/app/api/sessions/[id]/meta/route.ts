import { NextResponse } from "next/server";
import { saveSessionMeta } from "@/lib/session-meta";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    await saveSessionMeta(id, {
      title: body.title,
      description: body.description,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to save session meta:", error);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
