import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TOURNAMENT } from "@/lib/features";
import { serializeTournament, tournamentInclude, validScore } from "@/lib/tournament-db";

export const runtime = "nodejs";

// PATCH /api/tournaments/{id}/matches/{mid} : saisit un score (en JEUX). Réservé aux
// PARTICIPANTS du tournoi (et au créateur). { score1, score2 } alignés sur p1/p2 renvoyés
// par GET. Pour le tableau, les participants du match sont figés à cet instant (résolus au
// fur et à mesure). Un match déjà joué n'est ré-éditable que par le créateur.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id, mid } = await params;

  const body = await req.json().catch(() => ({}));
  const { score1, score2 } = body as { score1?: unknown; score2?: unknown };
  if (typeof score1 !== "number" || typeof score2 !== "number") {
    return NextResponse.json({ error: "Score invalide" }, { status: 400 });
  }

  const t = await prisma.tournament.findUnique({ where: { id }, include: tournamentInclude });
  if (!t) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  const view = serializeTournament(t, session.userId);
  if (!view.isParticipant && !view.isCreator) {
    return NextResponse.json(
      { error: "Réservé aux participants du tournoi" },
      { status: 403 },
    );
  }
  if (!validScore(score1, score2, t.bestOf)) {
    const w = Math.ceil(t.bestOf / 2);
    return NextResponse.json(
      { error: `Score invalide : un camp à ${w} jeux, l'autre en dessous` },
      { status: 400 },
    );
  }

  // Retrouve le match dans la vue (poules ou tableau) pour connaître ses participants actuels.
  const poolMatch = view.pools?.flatMap((p) => p.matches).find((m) => m.id === mid) ?? null;
  const bracketMatch = view.bracket?.matches.find((m) => m.id === mid) ?? null;
  const m = poolMatch ?? bracketMatch;
  if (!m || !m.p1 || !m.p2) {
    return NextResponse.json({ error: "Match introuvable ou pas encore jouable" }, { status: 404 });
  }
  if (m.status === "bye") {
    return NextResponse.json({ error: "Ce match est un passage direct (bye)" }, { status: 400 });
  }
  if (m.status === "done" && !view.isCreator) {
    return NextResponse.json(
      { error: "Match déjà saisi — seul le créateur peut le corriger" },
      { status: 409 },
    );
  }

  const winnerId = score1 > score2 ? m.p1.id : m.p2.id;

  await prisma.match.update({
    where: { id: mid },
    data: {
      // Fige les participants (utile pour le tableau : slots résolus au moment du jeu).
      player1Id: m.p1.id,
      player2Id: m.p2.id,
      score1,
      score2,
      winnerId,
      status: "done",
    },
  });

  // Le tournoi est-il terminé ? serializeTournament calcule un statut « done » effectif
  // (poules toutes jouées, ou tableau entièrement classé) — on le fige en base.
  const after = await prisma.tournament.findUnique({ where: { id }, include: tournamentInclude });
  if (after && after.status !== "done") {
    const v2 = serializeTournament(after, session.userId);
    if (v2.status === "done") {
      await prisma.tournament.update({ where: { id }, data: { status: "done" } });
    }
  }

  return NextResponse.json({ ok: true });
}
