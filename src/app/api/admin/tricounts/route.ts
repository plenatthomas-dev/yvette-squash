import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listTricountsAdmin, deleteTricount } from "@/lib/tricount-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/tricounts — liste des tricounts (modération, étape 5).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  return NextResponse.json({ tricounts: await listTricountsAdmin() });
}

// POST /api/admin/tricounts  { id, action: "delete" }
export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Tricount invalide." }, { status: 400 });
  }
  if (body.action === "delete") {
    await deleteTricount(body.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
