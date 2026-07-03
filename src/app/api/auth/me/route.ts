import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { buildHandleMap } from "@/lib/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // On renvoie :
  //  - displayName : nom réel (fallback du « Bonjour » si pas de pseudo)
  //  - nickname    : pseudonyme choisi (affiché en priorité dans le « Bonjour »)
  //  - handle      : token dé-doublonné du joueur pour les créneaux (pseudo tronqué
  //    ou diminutif). Calculé sur l'ensemble des joueurs → identique à la grille ;
  //    le client s'en sert pour la mise à jour optimiste des présences.
  const users = await prisma.user.findMany({
    select: { id: true, displayName: true, nickname: true, createdAt: true },
  });
  const me = users.find((u) => u.id === session.userId);
  const handle = buildHandleMap(users).get(session.userId) ?? null;
  return NextResponse.json({
    displayName: session.displayName,
    nickname: me?.nickname ?? null,
    handle,
  });
}
