import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listRequestHistory } from "@/lib/moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/history — historique des demandes de compte traitées (approuvées / rejetées).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  return NextResponse.json({ history: await listRequestHistory() });
}
