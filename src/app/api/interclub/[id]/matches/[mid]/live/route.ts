import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { sequenceWinner, validGameSequence, type GameScore } from "@/lib/interclub";
import {
  derivedStatus,
  fixtureScore,
  parseLive,
  scorerIsStale,
  serializeLive,
} from "@/lib/interclub-db";
import { interclubChanged } from "@/lib/interclub-gate";
import {
  notifyFixtureDone,
  notifyFixtureStart,
  notifyGameDone,
  notifyMatchDone,
  type MatchLine,
} from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Erreur métier levée DANS la transaction : annule tout, puis se traduit en réponse HTTP. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// PUT /api/interclub/{id}/matches/{mid}/live : instantané du match en cours.
//   { live: { current, serving, servingBox, awaitingServeBox } | null, games: [{home,away}] }
//
// C'est le CHEMIN CHAUD de la soirée : le marqueur l'appelle au plus toutes les 5 s. Les jeux
// ne sont donc réécrits que lorsqu'ils ont réellement changé (≈ 5 fois par match, pas 200).
//
// Le corps porte l'ÉTAT DÉRIVÉ COMPLET, jamais un delta : le journal des points vit dans le
// navigateur du marqueur et n'en sort que sous cette forme. Les ÉCRITURES sont donc
// idempotentes, ce qui dispense d'une file d'attente ordonnée à la reprise après coupure.
//
// ⚠️ Les NOTIFICATIONS, elles, ne le seraient pas d'elles-mêmes. Elles sont gardées sur les
// TRANSITIONS d'état, comparées à ce qui a été lu en début de transaction : sans cela, un
// renvoi du même corps — précisément ce que fait la reprise après coupure — annoncerait une
// seconde fois la victoire à tous les abonnés.
//
// Tout est ATOMIQUE (Serializable + retry P2034), comme la route sœur `PATCH …/matches/{mid}`.
// Deux écritures simultanées sur le même match sont atteignables sans malveillance (deux
// onglets, ou un tiers qui reprend une prise périmée pendant que l'ancien téléphone finit
// d'émettre) et l'effacement/réécriture des jeux violerait alors `@@unique([matchId, number])`.
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

  // L'instantané passe par le MÊME lecteur que l'affichage (`parseLive`) avant d'être stocké :
  // ce qui entre en base est donc exactement ce qui pourra en ressortir — borné et normalisé —
  // et non le corps brut d'un client.
  const hasLive = live !== null && live !== undefined;
  const snapshot = hasLive ? parseLive(JSON.stringify(live)) : null;
  if (hasLive && snapshot === null) {
    return NextResponse.json({ error: "Instantané invalide" }, { status: 400 });
  }

  // Rempli DANS la transaction, consommé après : notifier depuis l'intérieur enverrait la
  // notification même si la transaction était finalement annulée. Porté par un objet, car
  // TypeScript ne suit pas les affectations faites dans une fermeture.
  const outcome: {
    value: {
      ctx: { fixtureId: string; teamId: string; teamName: string; opponent: string };
      done: boolean;
      started: boolean;
      players: { player: string; opponent: string };
      gameDone: GameScore[] | null;
      matchDone: { home: number; away: number } | null;
      fixtureDone: boolean;
      score: { home: number; away: number };
      lines: MatchLine[];
    } | null;
  } = { value: null };

  const runOnce = () =>
    prisma.$transaction(
      async (tx) => {
        outcome.value = null;

        const m = await tx.interclubMatch.findUnique({
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
        if (!m || m.interclubId !== id) throw new HttpError(404, "Match introuvable");

        // Seul le marqueur écrit. Une prise périmée est reprise en silence : le match doit
        // pouvoir continuer sur un autre téléphone sans passer par un écran d'erreur. Un match
        // TERMINÉ, en revanche, n'appartient qu'à celui qui le marquait — sinon n'importe quel
        // membre réécrirait un score final, la route sœur `PATCH` étant seule à s'en protéger.
        if (m.scorerId !== session.userId) {
          if (m.status === "done") {
            throw new HttpError(409, "Ce match est terminé — passe par la correction du score");
          }
          if (m.scorerId !== null && !scorerIsStale(m.scorerClaimedAt, m.updatedAt)) {
            throw new HttpError(409, "Quelqu'un d'autre marque ce match");
          }
        }

        if (!validGameSequence(parsed, m.interclub.bestOf)) {
          throw new HttpError(400, "Score impossible pour ce format");
        }

        const winner = sequenceWinner(parsed, m.interclub.bestOf);

        // Les jeux ne sont réécrits QUE s'ils ont bougé.
        const same =
          m.games.length === parsed.length &&
          m.games.every((g, i) => g.pointsHome === parsed[i].home && g.pointsAway === parsed[i].away);

        if (!same) {
          await tx.interclubGame.deleteMany({ where: { matchId: mid } });
          if (parsed.length) {
            await tx.interclubGame.createMany({
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

        await tx.interclubMatch.update({
          where: { id: mid },
          data: {
            // La prise RESTE au marqueur après la victoire : il doit pouvoir annuler le point
            // décisif. Elle se périme d'elle-même au bout de SCORER_STALE_MS.
            scorerId: session.userId,
            scorerClaimedAt: new Date(), // toute écriture rafraîchit la prise
            liveJson: winner || !snapshot ? null : serializeLive(snapshot),
            gamesHome: parsed.length ? home : null,
            gamesAway: parsed.length ? away : null,
            status: winner ? "done" : parsed.length || snapshot ? "live" : "pending",
          },
        });

        const siblings = await tx.interclubMatch.findMany({
          where: { interclubId: id },
          orderBy: { order: "asc" },
          select: { gamesHome: true, gamesAway: true, status: true, homeDisplayName: true },
        });
        const nextStatus = derivedStatus(m.interclub.matchCount, siblings);
        await tx.interclub.update({ where: { id }, data: { status: nextStatus } });

        const wasDone = m.status === "done";
        const gamesGrew = parsed.length > m.games.length;
        outcome.value = {
          ctx: {
            fixtureId: id,
            teamId: m.interclub.teamId,
            teamName: m.interclub.team.name,
            opponent: m.interclub.opponent,
          },
          done: !!winner,
          started: m.interclub.status !== "live" && nextStatus === "live",
          players: { player: m.homeDisplayName, opponent: m.awayName },
          gameDone: !winner && gamesGrew ? parsed : null,
          matchDone: winner && !wasDone ? { home, away } : null,
          fixtureDone: m.interclub.status !== "done" && nextStatus === "done",
          score: fixtureScore(siblings),
          lines: siblings.map((s) => ({
            player: s.homeDisplayName,
            gamesHome: s.gamesHome,
            gamesAway: s.gamesAway,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  const isConflict = (e: unknown) =>
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";

  for (let attempt = 0; ; attempt++) {
    try {
      await runOnce();
      break;
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if (isConflict(e) && attempt < 3) continue;
      if (isConflict(e)) {
        return NextResponse.json({ error: "Saisie concurrente, réessaie" }, { status: 409 });
      }
      throw e;
    }
  }

  // Les spectateurs lisent un instantané mis en cache : sans cette invalidation, ils
  // resteraient sur le score précédent jusqu'à l'expiration du TTL.
  interclubChanged();

  const ev = outcome.value;
  if (ev) {
    if (ev.started) await notifyFixtureStart(ev.ctx, ev.players.player, ev.players.opponent);
    if (ev.matchDone) {
      await notifyMatchDone(
        ev.ctx,
        ev.players.player,
        ev.players.opponent,
        ev.matchDone.home,
        ev.matchDone.away,
        ev.score,
      );
    } else if (ev.gameDone) {
      await notifyGameDone(ev.ctx, ev.players.player, ev.players.opponent, ev.gameDone);
    }
    if (ev.fixtureDone) await notifyFixtureDone(ev.ctx, ev.score, ev.lines);
  }

  return NextResponse.json({ ok: true, done: !!ev?.done });
}
