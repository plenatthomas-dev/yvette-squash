import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { isFollowLevel } from "@/lib/interclub";
import { pushConfigured } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/follows : mes abonnements, une ligne par équipe suivie, et surtout
// `pushReady` — le serveur A-T-IL de quoi envoyer une notification (clés VAPID) ?
//
// C'est la SEULE source fiable sur ce point. Le client ne peut que consulter
// NEXT_PUBLIC_VAPID_PUBLIC_KEY, inlinée au build : elle dit si la clé publique existait au
// moment de compiler, pas si la clé PRIVÉE est présente à l'exécution. Sans cette réponse,
// s'abonner sur un environnement où les clés manquent affichait « Abonnement enregistré » et
// ne produisait jamais rien.
export async function GET(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;

  const rows = await prisma.interclubFollow.findMany({
    where: { userId: session.userId },
    select: { teamId: true, level: true },
  });
  return NextResponse.json({ follows: rows, pushReady: pushConfigured() });
}

// PUT /api/interclub/follows { teamId, level: "result"|"highlights"|"detailed"|null }
//
// `null` supprime l'abonnement. L'absence de ligne est l'état par défaut : personne ne reçoit
// rien tant qu'il ne l'a pas demandé — c'est un opt-in franc, pas un opt-out déguisé.
export async function PUT(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;

  const { teamId, level } = (await req.json().catch(() => ({}))) as {
    teamId?: unknown;
    level?: unknown;
  };

  if (typeof teamId !== "string" || !teamId) {
    return NextResponse.json({ error: "Équipe invalide" }, { status: 400 });
  }

  if (level === null) {
    await prisma.interclubFollow.deleteMany({ where: { userId: session.userId, teamId } });
    return NextResponse.json({ ok: true, level: null });
  }

  if (!isFollowLevel(level)) {
    return NextResponse.json({ error: "Niveau invalide" }, { status: 400 });
  }

  const team = await prisma.interclubTeam.findUnique({ where: { id: teamId }, select: { id: true } });
  if (!team) {
    return NextResponse.json({ error: "Équipe inconnue" }, { status: 400 });
  }

  await prisma.interclubFollow.upsert({
    where: { userId_teamId: { userId: session.userId, teamId } },
    update: { level },
    create: { userId: session.userId, teamId, level },
  });
  return NextResponse.json({ ok: true, level });
}
