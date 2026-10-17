import { NextRequest, NextResponse } from "next/server";
import { getAnnouncement } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/announce?id=…
// Le texte d'une annonce RÉELLEMENT envoyée depuis /admin (cf. settings.saveAnnouncement). Publique
// comme la notification qui y mène : l'identifiant est imprévisible, et le contenu est celui
// qu'on a déjà poussé à tous les membres. 404 pour un identifiant inconnu.
export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").slice(0, 40);
  const a = await getAnnouncement(id).catch(() => null);
  if (!a) return NextResponse.json({ error: "Annonce introuvable" }, { status: 404 });
  return NextResponse.json({ title: a.title, body: a.body, at: a.at });
}
