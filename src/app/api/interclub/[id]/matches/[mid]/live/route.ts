import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { sequenceWinner, validGameSequence, type GameScore } from "@/lib/interclub";
import { derivedStatus, fixtureScore, scorerIsStale, type LiveSnapshot } from "@/lib/interclub-db";
import { interclubChanged } from "@/lib/interclub-gate";
import {
  notifyFixtureDone,
  notifyFixtureStart,
  notifyGameDone,
  notifyMatchDone,
} from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/interclub/{id}/matches/{mid}/live : instantané du match en cours.
//   { live: { current, serving, servingBox, awaitingServeBox } | null, games: [{home,away}] }
//
// C'est le CHEMIN CHAUD de la soirée : le marqueur l'appelle au plus toutes les 5 s. Il reste
// donc volontairement léger — une lecture, une écriture de ligne, et les jeux réécrits
// seulement quand ils ont réellement changé (≈ 5 fois par match, pas 200).
//
// Le corps porte l'ÉTAT DÉRIVÉ COMPLET, jamais un delta : le journal des points vit dans le
// navigateur du marqueur, et n'en sort que sous cette forme. La requête est donc IDEMPOTENTE,
// ce qui est toute la raison pour laquelle la reprise après coupure réseau ne demande ni file
// d'attente ordonnée ni numéro de séquence — on renvoie l'état courant, un point c'est tout.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id, mid } = await params;

  const body = await req.json().catch(() => ({}));
  const { live, games } = body as { live?: unknown; games?: unknown };

  if (!Array.isArray(games)) {
    return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
  }
  const parsed: GameScore[] = [];
  for (const raw of games as unknown[]) {
    const g = raw as Record<string, unknown>;
    const home = Number(g?.home);
    const away = Number(g?.away);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
      return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
    }
    parsed.push({ home, away });
  }

  const m = await prisma.interclubMatch.findUnique({
    where: { id: mid },
    include: {
      games: { orderBy: { number: "asc" } },
      interclub: {
        select: {
          id: true,
          bestOf: true,
          matchCount: true,
          status: true,
          opponent: true,
          teamId: true,
          team: { select: { name: true } },
        },
      },
    },
  });
  if (!m || m.interclubId !== id) {
    return NextResponse.json({ error: "Match introuvable" }, { status: 404 });
  }

  // Seul le marqueur écrit. Une prise périmée est cependant reprise en silence : le match
  // doit pouvoir continuer sur un autre téléphone sans passer par un écran d'erreur.
  if (m.scorerId !== session.userId) {
    if (m.scorerId !== null && !scorerIsStale(m.scorerClaimedAt, m.updatedAt)) {
      return NextResponse.json({ error: "Quelqu'un d'autre marque ce match" }, { status: 409 });
    }
  }

  if (!validGameSequence(parsed, m.interclub.bestOf)) {
    return NextResponse.json({ error: "Score impossible pour ce format" }, { status: 400 });
  }

  const winner = sequenceWinner(parsed, m.interclub.bestOf);

  // Les jeux ne sont réécrits QUE s'ils ont bougé : la synchro passe toutes les 5 s, les jeux
  // changent une poignée de fois par match.
  const same =
    m.games.length === parsed.length &&
    m.games.every((g, i) => g.pointsHome === parsed[i].home && g.pointsAway === parsed[i].away);

  if (!same) {
    await prisma.interclubGame.deleteMany({ where: { matchId: mid } });
    if (parsed.length) {
      await prisma.interclubGame.createMany({
        data: parsed.map((g, i) => ({
          matchId: mid,
          number: i + 1,
          pointsHome: g.home,
          pointsAway: g.away,
          finishedAt: new Date(),
        })),
      });
    }
  }

  let home = 0;
  let away = 0;
  for (const g of parsed) {
    if (g.home > g.away) home += 1;
    else away += 1;
  }

  const snapshot =
    live && typeof live === "object" ? JSON.stringify(live as LiveSnapshot) : null;

  await prisma.interclubMatch.update({
    where: { id: mid },
    data: {
      scorerId: winner ? null : session.userId,
      scorerClaimedAt: winner ? null : new Date(), // toute écriture rafraîchit la prise
      liveJson: winner ? null : snapshot,
      gamesHome: parsed.length ? home : null,
      gamesAway: parsed.length ? away : null,
      status: winner ? "done" : "live",
    },
  });

  // Recale le statut de la rencontre : sinon la liste reste « à venir » alors qu'un match
  // est en cours sous les yeux de tout le monde.
  const siblings = await prisma.interclubMatch.findMany({
    where: { interclubId: id },
    select: { gamesHome: true, gamesAway: true, status: true },
  });
  const nextStatus = derivedStatus(m.interclub.matchCount, siblings);
  await prisma.interclub.update({ where: { id }, data: { status: nextStatus } });

  // Les spectateurs lisent un instantané mis en cache : sans cette invalidation, ils
  // resteraient sur le score précédent jusqu'à l'expiration du TTL.
  interclubChanged();

  // --- notifications, sur les TRANSITIONS seulement ---------------------------
  // On ne notifie jamais « au fil de l'eau » : c'est le passage d'un état à un autre qui fait
  // événement. Tout est best-effort et n'engage pas la réponse — un envoi raté ne doit pas
  // faire échouer la saisie d'un point.
  const ctx = {
    fixtureId: id,
    teamId: m.interclub.teamId,
    teamName: m.interclub.team.name,
    opponent: m.interclub.opponent,
  };
  const gamesGrew = parsed.length > m.games.length;

  if (m.interclub.status !== "live" && nextStatus === "live") {
    await notifyFixtureStart(ctx);
  }
  if (winner) {
    await notifyMatchDone(
      ctx,
      m.homeDisplayName,
      m.awayName,
      home,
      away,
      fixtureScore(siblings),
    );
  } else if (gamesGrew) {
    await notifyGameDone(ctx, m.homeDisplayName, m.awayName, parsed);
  }
  if (m.interclub.status !== "done" && nextStatus === "done") {
    await notifyFixtureDone(ctx, fixtureScore(siblings));
  }

  return NextResponse.json({ ok: true, done: !!winner });
}
