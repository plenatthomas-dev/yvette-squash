import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { setBannerSeen } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/banner/dismiss  { what: "banner" | "modal", version }
// Mémorise, SUR LE COMPTE, que ce membre a fermé le bandeau ou vu la modale de cette annonce —
// il ne la reverra donc plus, y compris après déconnexion ou depuis un autre appareil. Une
// nouvelle annonce porte une autre `version` et repasse devant les yeux.
//
// `getSession` (et non le contrôle allégé du GET) : c'est une écriture, on suit la convention
// d'auth du reste des routes. Un membre n'écrit que sur son propre compte (l'id vient de la
// session, jamais du corps de la requête).
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const raw = (await req.json().catch(() => ({}))) as { what?: unknown; version?: unknown };
  if (raw.what !== "banner" && raw.what !== "modal") {
    return NextResponse.json({ error: "Cible inconnue." }, { status: 400 });
  }
  if (typeof raw.version !== "string" || !raw.version) {
    return NextResponse.json({ error: "Version manquante." }, { status: 400 });
  }

  await setBannerSeen(session.userId, raw.what, raw.version);
  return NextResponse.json({ ok: true });
}
