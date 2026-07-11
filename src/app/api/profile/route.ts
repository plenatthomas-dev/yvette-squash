import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { invalidateAnnotationUsers } from "@/lib/planning-annotate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bornes du pseudonyme. Court car affiché dans des cases étroites ; on garde une
// marge confortable pour le « Bonjour » (le créneau tronque de son côté).
const NICK_MAX = 24;
// Lettres (accents inclus), chiffres, espace, tiret, apostrophe, point. Pas de balises.
const NICK_ALLOWED = /^[\p{L}\p{N} .'\-]+$/u;

// PATCH /api/profile  { nickname?: string | null, listed?: boolean }
// Met à jour le profil du joueur courant. Les deux champs sont indépendants et optionnels :
//  - nickname : pseudonyme (vide/null → retour au diminutif auto). Modifiable à volonté.
//  - listed   : visibilité dans l'annuaire (idée 6, opt-out). Absent = inchangé.
export async function PATCH(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    nickname?: unknown;
    listed?: unknown;
  };

  const data: { nickname?: string | null; listed?: boolean } = {};

  // Pseudonyme : traité seulement si la clé est présente dans le corps.
  if ("nickname" in body) {
    if (body.nickname === null) {
      data.nickname = null; // effacement → on revient au diminutif auto
    } else if (typeof body.nickname !== "string") {
      return NextResponse.json({ error: "Pseudonyme invalide" }, { status: 400 });
    } else {
      const trimmed = body.nickname.trim().replace(/\s+/g, " ");
      if (trimmed.length === 0) {
        data.nickname = null;
      } else if (trimmed.length > NICK_MAX) {
        return NextResponse.json(
          { error: `Pseudonyme trop long (max ${NICK_MAX} caractères).` },
          { status: 400 },
        );
      } else if (!NICK_ALLOWED.test(trimmed)) {
        return NextResponse.json(
          { error: "Caractères non autorisés dans le pseudonyme." },
          { status: 400 },
        );
      } else {
        data.nickname = trimmed;
      }
    }
  }

  // Visibilité annuaire : booléen strict si présent.
  if ("listed" in body) {
    if (typeof body.listed !== "boolean") {
      return NextResponse.json({ error: "Visibilité invalide" }, { status: 400 });
    }
    data.listed = body.listed;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Rien à mettre à jour" }, { status: 400 });
  }

  // Unicité du pseudonyme, INSENSIBLE À LA CASSE : deux joueurs ne peuvent pas afficher le
  // même pseudo (« Tom » vs « tom » compris), sinon on ne les distingue plus dans les
  // créneaux et les listes. Contrôle applicatif (pas de contrainte DB : des doublons ont pu
  // exister avant cette règle, et une course simultanée sur un même pseudo est négligeable
  // pour l'usage d'un club). Ignoré quand on EFFACE le pseudo (retour au diminutif auto).
  if (typeof data.nickname === "string" && data.nickname.length > 0) {
    const taken = await prisma.user.findFirst({
      where: {
        id: { not: session.userId },
        nickname: { equals: data.nickname, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json(
        { error: "Ce pseudonyme est déjà pris par un autre membre." },
        { status: 409 },
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id: session.userId },
    data,
    select: { nickname: true, listed: true },
  });
  // Le pseudo/la visibilité changent → le cache mémoire de la liste des membres (annotation)
  // doit refléter le nouveau nom sans attendre son TTL.
  invalidateAnnotationUsers();
  return NextResponse.json({ ok: true, ...updated });
}
