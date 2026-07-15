import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { pushToAll, pushConfigured } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bornes volontairement serrées : une annonce push est courte (titre + une ligne). Au-delà,
// le système d'exploitation tronque de toute façon la notification.
const MAX_TITLE = 80;
const MAX_BODY = 300;

// POST /api/admin/announce  { title, body }
// Diffuse une notification push à tous les membres abonnés (annonce club). Accès réservé aux
// admins (allowlist ADMIN_EMAILS) — indépendant du flag `emailLogin` : le push est une
// capacité de base, pas liée à la connexion par e-mail.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  if (!pushConfigured()) {
    return NextResponse.json({ error: "Notifications non configurées (clés VAPID absentes)." }, {
      status: 503,
    });
  }

  const raw = (await req.json().catch(() => ({}))) as { title?: unknown; body?: unknown };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!title || !body) {
    return NextResponse.json({ error: "Titre et message obligatoires." }, { status: 400 });
  }
  if (title.length > MAX_TITLE || body.length > MAX_BODY) {
    return NextResponse.json({ error: "Titre ou message trop long." }, { status: 400 });
  }

  // URL de clic : porte l'annonce en paramètres → au clic sur la notif, l'appli s'ouvre et
  // ré-affiche le message dans une modale (cf. AnnounceModal). Stateless : rien à stocker.
  const url = `/?${new URLSearchParams({ announce: "1", t: title, b: body }).toString()}`;
  // tag fixe : une nouvelle annonce remplace la précédente non lue plutôt que d'empiler.
  const { recipients, sent } = await pushToAll({ title, body, url, tag: "admin-announce" });
  return NextResponse.json({ ok: true, recipients, sent });
}
