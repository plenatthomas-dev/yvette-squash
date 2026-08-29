import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { HttpError, httpErrorResponse, readJsonBody, serializableTransaction } from "@/lib/http-tx";
import { sequenceWinner, validGameSequence, type GameScore } from "@/lib/interclub";
import {
  derivedStatus,
  staleGamesReason,
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

// PUT /api/interclub/{id}/matches/{mid}/live : instantané du match en cours.
//   { live: { current, serving, servingBox, awaitingServeBox } | null, games: [{home,away}],
//     knownGameCount? }
//
// C'est le CHEMIN CHAUD de la soirée : le marqueur l'appelle au plus toutes les 5 s. Les jeux
// ne sont donc réécrits que lorsqu'ils ont réellement changé (≈ 5 fois par match, pas 200).
//
// Le corps porte l'ÉTAT DÉRIVÉ COMPLET, jamais un delta : le journal des points vit dans le
// navigateur du marqueur et n'en sort que sous cette forme. Les ÉCRITURES sont donc
// idempotentes, ce qui dispense d'une file d'attente ordonnée à la reprise après coupure.
//
// ⚠️ L'IDEMPOTENCE NE VAUT QUE POUR UN RENVOI DU MÊME CORPS, pas pour un corps PÉRIMÉ — et
// comme `games` remplace intégralement la liste, un corps périmé EFFACE. D'où `knownGameCount`,
// même mécanique que sur la route sœur `PATCH` : le marqueur annonce combien de jeux le serveur
// lui avait confirmés, et si la base en a un autre nombre, c'est que quelqu'un a écrit
// entre-temps et que son journal ne décrit plus rien.
//
// Le trou que cela ferme, sans malveillance ni concurrence d'aucune sorte : le marqueur compte
// deux jeux puis fait « Retour » (la prise est relâchée, le journal local RESTE — il n'est
// purgé que sur un match terminé) ; un capitaine saisit le 3ᵉ jeu a posteriori ; le marqueur
// rouvre le marquage, son journal local l'emporte sur le serveur à l'amorçage, et le premier
// point tapé renvoyait deux jeux là où la base en avait trois — le troisième disparaissait,
// `gamesHome/gamesAway` régressaient, et la garde d'exclusion mutuelle ne s'y opposait pas
// puisque plus personne ne tenait le match. Un `Serializable` n'y peut rien : les deux
// écritures ne sont pas concurrentes, la seconde est juste calculée sur un état mort.
//
// Le champ reste FACULTATIF pour une écriture qui fait CROÎTRE la liste — le chemin du marqueur
// point par point, qui ne détruit rien. Il devient obligatoire pour en RETIRER : c'est la seule
// façon de distinguer « je n'ai encore rien à dire » de « efface tout ». Le code `stale-games`
// du refus dit au marqueur de repartir du serveur, là où l'autre 409 de cette route
// (« quelqu'un d'autre marque ») lui dit de renoncer.
//
// ⚠️ Les NOTIFICATIONS, elles, ne le seraient pas d'elles-mêmes. Celles qui portent sur le MATCH
// (jeu terminé, match gagné) sont gardées sur des transitions comparées à ce qui a été lu en
// début de transaction : sans cela, un renvoi du même corps — précisément ce que fait la reprise
// après coupure — annoncerait une seconde fois la victoire à tous les abonnés. Les deux qui
// portent sur la RENCONTRE sont gardées par des marqueurs persistants (`startNotifiedAt`,
// `doneNotifiedAt`), parce que le statut d'une rencontre, lui, redescend légitimement.
//
// Tout est ATOMIQUE (Serializable + retry P2034), comme la route sœur `PATCH …/matches/{mid}`.
// Deux écritures simultanées sur le même match sont atteignables sans malveillance (deux
// onglets, ou un tiers qui reprend une prise périmée pendant que l'ancien téléphone finit
// d'émettre) et l'effacement/réécriture des jeux violerait alors `@@unique([matchId, number])`.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id, mid } = await params;

  const body = await readJsonBody(req);
  const { live, games, knownGameCount } = body as {
    live?: unknown;
    games?: unknown;
    knownGameCount?: unknown;
  };
  if (knownGameCount !== undefined && (!Number.isInteger(knownGameCount) || (knownGameCount as number) < 0)) {
    return NextResponse.json({ error: "knownGameCount invalide" }, { status: 400 });
  }

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

  /**
   * L'instantané porte-t-il un match RÉELLEMENT commencé ?
   *
   * Un instantané à 0-0, sans aucun jeu, n'est pas un match qui a démarré : c'est la
   * désignation du premier serveur, faite pendant l'échauffement. Le marqueur l'envoie parce
   * que l'écran synchronise tout changement, et le serveur en concluait « en direct ».
   *
   * Ce raccourci coûtait cher, et exactement ce que `claim/route.ts` dit avoir écarté : toucher
   * « Marquer », choisir qui sert, puis « Retour » envoyait « La rencontre commence » à tous les
   * abonnés, posait `startNotifiedAt` DÉFINITIVEMENT — le vrai début ne notifiait donc plus
   * jamais — et laissait le simple « en cours » avec un 0-0, sondé toutes les dix secondes.
   *
   * Le score de l'instantané est bien stocké dans les deux cas : le serveur désigné ne se perd
   * pas. Seul le STATUT attend le premier point.
   */
  const enJeu = !!snapshot && (snapshot.current.home > 0 || snapshot.current.away > 0);
  if (hasLive && snapshot === null) {
    return NextResponse.json({ error: "Instantané invalide" }, { status: 400 });
  }

  // Ce qu'il y aura à ANNONCER, calculé dans la transaction et consommé après elle : notifier
  // depuis l'intérieur enverrait la notification même si la transaction était finalement
  // annulée.
  //
  // C'est la valeur de RETOUR de la transaction, et non plus une variable remplie au passage.
  // La nuance compte : sur rejeu après conflit de sérialisation, le corps repart de zéro et
  // produit sa propre valeur, là où une variable partagée devait être remise à zéro à la main
  // — un oubli aurait notifié deux fois.
  interface Outcome {
    ctx: { fixtureId: string; teamId: string; teamName: string; opponent: string };
    done: boolean;
    started: boolean;
    players: { player: string; opponent: string };
    gameDone: GameScore[] | null;
    matchDone: { home: number; away: number } | null;
    fixtureDone: boolean;
    score: { home: number; away: number };
    lines: MatchLine[];
  }

  let ev: Outcome;
  try {
    ev = await serializableTransaction(async (tx): Promise<Outcome> => {
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
              startNotifiedAt: true,
              doneNotifiedAt: true,
              opponent: true,
              teamId: true,
              team: { select: { name: true } },
            },
          },
        },
      });
      if (!m || m.interclubId !== id) throw new HttpError(404, "Match introuvable");

      // ⚠️ CE CONTRÔLE N'EST PAS UN CONTRÔLE D'ACCÈS — c'est un contrôle d'EXCLUSION MUTUELLE.
      // Tout membre connecté peut marquer n'importe quel match LIBRE, et c'est voulu : le
      // modèle d'autorisation de l'interclub n'a qu'un rôle, « membre connecté »
      // (cf. `interclub-access.ts` et `docs/interclub.md`). Ce que le code protège ici, ce
      // n'est donc pas le match contre un intrus, c'est le MARQUEUR EN COURS contre un
      // écrasement — deux personnes qui comptent le même match produiraient deux scores
      // divergents, sans moyen de trancher.
      //
      // Trois cas, dans cet ordre :
      //   * c'est déjà mon match → j'écris ;
      //   * il est TERMINÉ et ce n'est pas le mien → refus : un score final ne se réécrit que
      //     par la route sœur `PATCH`, qui elle demande une raison d'y toucher ;
      //   * quelqu'un le tient et sa prise n'est PAS périmée → refus.
      // Sinon — personne, ou une prise périmée — je le reprends en silence : le match doit
      // pouvoir continuer sur un autre téléphone sans passer par un écran d'erreur.
      if (m.scorerId !== session.userId) {
        if (m.status === "done") {
          throw new HttpError(409, "Ce match est terminé — passe par la correction du score");
        }
        if (m.scorerId !== null && !scorerIsStale(m.scorerClaimedAt)) {
          throw new HttpError(409, "Quelqu'un d'autre marque ce match");
        }
      }

      // GARDE DE FRAÎCHEUR — cf. l'en-tête. Le compte annoncé est celui que le SERVEUR avait
      // confirmé au marqueur, pas celui qu'il envoie maintenant : un undo qui défait un jeu
      // gagnant reste donc parfaitement légal (il raccourcit `parsed`, pas `knownGameCount`),
      // et seul un journal calculé sur un état que la base a dépassé est refusé.
      // Une seule règle, partagée avec la route sœur `PATCH` : elle vivait en double, et les
      // deux copies avaient divergé (cf. `staleGamesReason`).
      const perime = staleGamesReason(knownGameCount as number | undefined, m.games, parsed);
      if (perime) throw new HttpError(409, perime, "stale-games");

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
          status: winner ? "done" : parsed.length || enJeu ? "live" : "pending",
        },
      });

      const siblings = await tx.interclubMatch.findMany({
        where: { interclubId: id },
        orderBy: { order: "asc" },
        select: { gamesHome: true, gamesAway: true, status: true, homeDisplayName: true },
      });
      const nextStatus = derivedStatus(m.interclub.matchCount, siblings);

      // ⚠️ Gardes sur MARQUEURS PERSISTANTS, et non sur une comparaison de statut : le statut
      // d'une rencontre redescend légitimement (cf. la route sœur `PATCH`, où vider les jeux
      // d'un simple ramène la rencontre de `done` à `live`), et chaque redescente réarmait les
      // transitions. Un marqueur ne se réarme pas — quoi qu'il arrive à la colonne `status`, y
      // compris le recalage que le `GET` du détail lui applique.
      const fixtureStarted = nextStatus === "live" && m.interclub.startNotifiedAt === null;
      const fixtureNewlyDone = nextStatus === "done" && m.interclub.doneNotifiedAt === null;
      const notifiedAt = new Date();
      await tx.interclub.update({
        where: { id },
        data: {
          status: nextStatus,
          ...(fixtureStarted ? { startNotifiedAt: notifiedAt } : {}),
          ...(fixtureNewlyDone ? { doneNotifiedAt: notifiedAt } : {}),
        },
      });

      const wasDone = m.status === "done";
      const gamesGrew = parsed.length > m.games.length;
    return {
      ctx: {
        fixtureId: id,
        teamId: m.interclub.teamId,
        teamName: m.interclub.team.name,
        opponent: m.interclub.opponent,
      },
      done: !!winner,
      started: fixtureStarted,
      players: { player: m.homeDisplayName, opponent: m.awayName },
      gameDone: !winner && gamesGrew ? parsed : null,
      matchDone: winner && !wasDone ? { home, away } : null,
      fixtureDone: fixtureNewlyDone,
      score: fixtureScore(siblings),
      lines: siblings.map((s) => ({
        player: s.homeDisplayName,
        gamesHome: s.gamesHome,
        gamesAway: s.gamesAway,
      })),
    };
    }, "Saisie concurrente, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }

  // Les spectateurs lisent un instantané mis en cache : sans cette invalidation, ils
  // resteraient sur le score précédent jusqu'à l'expiration du TTL.
  interclubChanged();

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

  return NextResponse.json({ ok: true, done: ev.done });
}
