import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { setBanner, clearBanner, BANNER_MAX, type BannerLevel } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/banner  { message, level? }
// Message vide/blanc → retire la bannière ; sinon la pose (level "info" par défaut, "warn"
// pour un ton alerte). Complète l'annonce push : visible même sans notifications activées.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const raw = (await req.json().catch(() => ({}))) as { message?: unknown; level?: unknown };
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (message.length > BANNER_MAX) {
    return NextResponse.json({ error: "Message trop long." }, { status: 400 });
  }

  if (!message) {
    await clearBanner();
    return NextResponse.json({ ok: true, banner: null });
  }
  const level: BannerLevel = raw.level === "warn" ? "warn" : "info";
  await setBanner(message, level, admin.userId);
  return NextResponse.json({ ok: true });
}
