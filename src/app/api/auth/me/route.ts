import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { buildHandleMap } from "@/lib/handle";
import { isAdminEmail } from "@/lib/admin";
import { countPendingRequests } from "@/lib/email-auth";

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
    select: { id: true, displayName: true, nickname: true, listed: true, createdAt: true, email: true },
  });
  const me = users.find((u) => u.id === session.userId);
  const handle = buildHandleMap(users).get(session.userId) ?? null;
  // Admin (allowlist ADMIN_EMAILS) : pilote l'entrée « Admin » + son badge de demandes en attente.
  const isAdmin = isAdminEmail(me?.email);
  const pendingRequests = isAdmin ? await countPendingRequests() : 0;
  return NextResponse.json({
    // Id interne du membre : permet au client de se reconnaître dans les listes
    // issues de l'annuaire (ex. s'exclure du choix des délégués).
    id: session.userId,
    displayName: session.displayName,
    nickname: me?.nickname ?? null,
    // Visibilité annuaire (idée 6) : pilote la case opt-out des paramètres.
    listed: me?.listed ?? true,
    handle,
    // Pilote l'UI : "email" = session sans ResaMania (lecture seule, pas de réservation).
    mode: session.resa ? "resamania" : "email",
    canBook: !!session.resa,
    isAdmin,
    pendingRequests,
  });
}
