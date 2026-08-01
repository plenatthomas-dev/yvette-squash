import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import {
  getAppBlockSetting,
  setAppBlock,
  clearAppBlock,
  BLOCK_MAX,
} from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/block — état courant du blocage (switch + message), pour pré-remplir /admin.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  return NextResponse.json(await getAppBlockSetting(), {
    headers: { "Cache-Control": "no-store" },
  });
}

// POST /api/admin/block  { enabled: boolean, message?: string }
// Ferme l'appli aux membres (les admins gardent l'accès complet) ou la rouvre. Le message est
// conservé même à la réouverture, pour rester pré-rempli la fois suivante.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const raw = (await req.json().catch(() => ({}))) as { enabled?: unknown; message?: unknown };
  if (typeof raw.enabled !== "boolean") {
    return NextResponse.json({ error: "État attendu (enabled)." }, { status: 400 });
  }
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (message.length > BLOCK_MAX) {
    return NextResponse.json({ error: "Message trop long." }, { status: 400 });
  }

  if (raw.enabled) {
    await setAppBlock(message, admin.userId);
  } else {
    await clearAppBlock(message, admin.userId);
  }
  return NextResponse.json({ ok: true, ...(await getAppBlockSetting()) });
}
