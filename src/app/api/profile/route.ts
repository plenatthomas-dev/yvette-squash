import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bornes du pseudonyme. Court car affiché dans des cases étroites ; on garde une
// marge confortable pour le « Bonjour » (le créneau tronque de son côté).
const NICK_MAX = 24;
// Lettres (accents inclus), chiffres, espace, tiret, apostrophe, point. Pas de balises.
const NICK_ALLOWED = /^[\p{L}\p{N} .'\-]+$/u;

// PATCH /api/profile  { nickname: string | null }
// Définit (ou efface si vide/null) le pseudonyme du joueur courant. Modifiable à volonté.
export async function PATCH(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { nickname?: unknown };

  let nickname: string | null;
  if (body.nickname === null || body.nickname === undefined) {
    nickname = null; // effacement → on revient au diminutif auto
  } else if (typeof body.nickname !== "string") {
    return NextResponse.json({ error: "Pseudonyme invalide" }, { status: 400 });
  } else {
    const trimmed = body.nickname.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) {
      nickname = null;
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
      nickname = trimmed;
    }
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { nickname },
  });
  return NextResponse.json({ ok: true, nickname });
}
