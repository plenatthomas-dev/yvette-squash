import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { HttpError, httpErrorResponse, readJsonBody, serializableTransaction } from "@/lib/http-tx";
import { Prisma } from "@prisma/client";
import { isAdminEmail } from "@/lib/admin";
import {
  isColorValue,
  normalizeColor,
  sequenceWinner,
  validGameSequence,
  type GameScore,
} from "@/lib/interclub";
import {
  derivedStatus,
  staleGamesReason,
  fixtureScore,
  scorerIsStale,
  MAX_PLAYER_NAME_LEN,
} from "@/lib/interclub-db";
import { findAlignmentClash, resolveHomePick } from "@/lib/interclub-roster";
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

// PATCH /api/interclub/{id}/matches/{mid} : composition et/ou score d'un simple.
//   { homeUserId?, homeGuestId?, awayName?, homeColor?, awayColor?,
//     games?: [{ home, away }], knownGameCount? }
//
// `games` remplace INTÉGRALEMENT la liste des jeux : c'est une correction de saisie, pas un
// ajout incrémental — on évite ainsi qu'une double soumission crée deux fois le même jeu.
//
// ⚠️ C'est ce remplacement intégral qui rend cette route DANGEREUSE, et deux gardes distinctes
// le tiennent (cf. plus bas, dans la transaction) :
//   1. la PRISE DE MARQUAGE — on n'écrit pas de jeux sous les doigts de celui qui marque ;
//   2. `knownGameCount` — l'écran qui enregistre doit avoir vu le même nombre de jeux que la
//      base. Sans cela, un formulaire ouvert dix minutes plus tôt renvoyait `games: []` et
//      effaçait ce qui avait été joué entre-temps, sans conflit de sérialisation possible :
//      les deux écritures ne sont pas concurrentes, la seconde est juste calculée sur un état
//      périmé. Un `Serializable` ne protège de rien dans ce cas.
//
// Tout est ATOMIQUE (Serializable + retry P2034) : plusieurs personnes saisissent en parallèle
// un soir de rencontre, et le statut de la rencontre se recale dans la même transaction.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id, mid } = await params;

  const body = await readJsonBody(req);
  const { homeUserId, homeGuestId, awayName, homeColor, awayColor, games, knownGameCount } =
    body as {
      homeUserId?: unknown;
      homeGuestId?: unknown;
      awayName?: unknown;
      homeColor?: unknown;
      awayColor?: unknown;
      games?: unknown;
      knownGameCount?: unknown;
    };

  if (!isColorValue(homeColor) || !isColorValue(awayColor)) {
    return NextResponse.json({ error: "Couleur inconnue" }, { status: 400 });
  }

  // La composition est TOUCHÉE dès que l'une des deux clés est présente, `null` compris — c'est
  // ainsi que l'écran remet un simple à « à désigner ».
  const touchesLineup = "homeUserId" in body || "homeGuestId" in body;

  // Normalise les jeux avant d'ouvrir la transaction : une saisie invalide ne doit même pas
  // toucher la base.
  let parsedGames: GameScore[] | null = null;
  if (games !== undefined) {
    if (!Array.isArray(games)) {
      return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
    }
    const out: GameScore[] = [];
    for (const raw of games as unknown[]) {
      const g = raw as Record<string, unknown>;
      const home = Number(g?.home);
      const away = Number(g?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
        return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
      }
      out.push({ home, away });
    }
    parsedGames = out;
  }

  // L'e-mail vient de la SESSION, déjà chargée : plus de `user.findUnique` ici. L'ancienne
  // version en émettait un depuis l'INTÉRIEUR de la transaction, et sur le client global —
  // donc une seconde connexion mobilisée pendant qu'une transaction Serializable en détenait
  // déjà une, motif classique d'interblocage sur un pool serverless étroit.
  const admin = isAdminEmail(session.email);

  // Ce qu'il y aura à ANNONCER, calculé dans la transaction et consommé après elle : notifier
  // depuis l'intérieur enverrait la notification même si la transaction était finalement
  // annulée. `null` = rien ne s'est produit qui mérite d'être annoncé.
  //
  // C'est la valeur de RETOUR de la transaction, et non plus une variable remplie au passage.
  // La nuance compte : sur rejeu après conflit de sérialisation, le corps repart de zéro et
  // produit sa propre valeur, là où une variable partagée devait être remise à zéro à la main
  // — un oubli aurait notifié deux fois.
  interface Outcome {
    ctx: { fixtureId: string; teamId: string; teamName: string; opponent: string };
    players: { player: string; opponent: string };
    gameDone: GameScore[] | null;
    matchDone: { home: number; away: number } | null;
    fixtureStarted: boolean;
    fixtureDone: boolean;
    score: { home: number; away: number };
    lines: MatchLine[];
  }

  /**
   * Marque « la transaction n'a RIEN écrit », qu'il faut distinguer de « elle a écrit, mais il
   * n'y a rien à annoncer » — les deux rendaient `null`, et le second doit purger le cache du
   * direct quand le premier ne le doit pas.
   */
  const RIEN_ECRIT = Symbol("rien-ecrit");

  let ev: Outcome | null | typeof RIEN_ECRIT;
  try {
    ev = await serializableTransaction(async (tx): Promise<Outcome | null | typeof RIEN_ECRIT> => {
      const m = await tx.interclubMatch.findUnique({
        where: { id: mid },
        include: {
          // Les POINTS, et pas seulement le nombre : la garde de fraîcheur compare désormais
          // le score des jeux déjà confirmés, un même nombre ne prouvant pas qu'on parle des
          // mêmes jeux (cf. `staleGamesReason`).
          games: { select: { number: true, pointsHome: true, pointsAway: true } },
          interclub: {
            select: {
              id: true,
              bestOf: true,
              matchCount: true,
              createdById: true,
              teamId: true,
              status: true,
              startNotifiedAt: true,
              doneNotifiedAt: true,
              opponent: true,
              team: { select: { name: true } },
            },
          },
        },
      });
      if (!m || m.interclubId !== id) {
        throw new HttpError(404, "Match introuvable");
      }

      // Un match ENTAMÉ n'est modifiable que par ceux qui ont une raison d'y toucher : le
      // créateur de la rencontre, le joueur concerné, le marqueur, ou un admin. Sinon on
      // refuse plutôt que d'écraser silencieusement le travail de quelqu'un d'autre.
      //
      // ⚠️ « Entamé » ne peut PAS se lire sur `gamesHome !== null` seul : cette colonne reste
      // nulle pendant tout le PREMIER jeu, si bien que la garde ne servait à rien exactement
      // au moment où le match est le plus vivant. On regarde donc aussi le statut et les jeux
      // déjà enregistrés — même erreur de lecture que celle documentée sur `derivedStatus`.
      const started =
        m.gamesHome !== null || m.status === "live" || m.status === "done" || m.games.length > 0;
      const closeToIt =
        m.interclub.createdById === session.userId ||
        m.homeUserId === session.userId ||
        m.scorerId === session.userId;
      if (started && !closeToIt && !admin) {
        throw new HttpError(409, "Score déjà saisi par quelqu'un d'autre");
      }

      // GARDE 1 — la prise de marquage. Tant qu'un marqueur NON PÉRIMÉ tient ce match, ses
      // jeux lui appartiennent : cette route ne s'en mêle pas. La route sœur `PUT …/live` se
      // protégeait déjà ainsi ; ici rien ne consultait `scorerId` en dehors de `closeToIt`,
      // et un capitaine qui corrigeait un nom sur un écran ouvert dix minutes plus tôt
      // effaçait le jeu que le marqueur venait de clore.
      //
      // La composition et les couleurs, elles, restent modifiables pendant le marquage : ce
      // sont justement les corrections qu'on fait au bord du terrain, et elles ne touchent
      // aucun jeu.
      const heldByOther =
        m.scorerId !== null &&
        m.scorerId !== session.userId &&
        !scorerIsStale(m.scorerClaimedAt);
      if (parsedGames && heldByOther) {
        throw new HttpError(409, "Quelqu'un marque ce match en direct — attends qu'il ait fini");
      }

      // GARDE 2 — concurrence optimiste sur les jeux. L'écran annonce combien de jeux il
      // avait sous les yeux ; s'il en manque ou s'il y en a plus, c'est qu'il a été rempli
      // sur un état qui n'existe plus, et son `games` effacerait ce qu'il n'a jamais vu.
      // Facultatif : un client qui ne l'envoie pas garde l'ancien comportement (aucune
      // rupture pour les corrections faites depuis un écran fraîchement chargé).
      if (parsedGames) {
        if (knownGameCount !== undefined && (!Number.isInteger(knownGameCount) || (knownGameCount as number) < 0)) {
          throw new HttpError(400, "knownGameCount invalide");
        }
        // MÊME RÈGLE QUE LA ROUTE SŒUR, et c'est maintenant littéralement le même code.
        //
        // Elle ne l'était pas : ici tout était conditionné à la PRÉSENCE du champ, si bien
        // qu'un `{ games: [] }` sans rien annoncer effaçait les jeux d'un simple et le
        // ramenait à `pending`. `docs/interclub.md` affirmait pourtant que la garde couvrait
        // les DEUX routes d'écriture.
        const perime = staleGamesReason(knownGameCount as number | undefined, m.games, parsedGames);
        if (perime) throw new HttpError(409, perime, "stale-games");
      }

      if (parsedGames && !validGameSequence(parsedGames, m.interclub.bestOf)) {
        throw new HttpError(400, "Score impossible pour ce format");
      }

      const data: Prisma.InterclubMatchUpdateInput = {};

      // Composition. Un simple porte un MEMBRE ou un INVITÉ (joueur d'équipe sans compte),
      // jamais les deux, et jamais un nom libre : `resolveHomePick` applique la règle du club
      // contre `teamId` lu en base. C'est la MÊME fonction qu'emploie la création d'une
      // rencontre — la règle ne peut donc plus tenir d'un côté et pas de l'autre.
      //
      // Résolu avec `tx` et non le client global : la vérification d'appartenance doit voir
      // le même état que l'écriture qu'elle autorise.
      if (touchesLineup) {
        const resolved = await resolveHomePick(tx, m.interclub.teamId, {
          userId: homeUserId,
          guestId: homeGuestId,
        });
        if (!resolved.ok) throw new HttpError(400, resolved.error);
        const p = resolved.value;
        // Un joueur ne dispute qu'un simple par rencontre. La création l'imposait déjà (à
        // l'intérieur de son propre formulaire) ; ici rien ne le vérifiait, et rouvrir un
        // simple suffisait à aligner une seconde fois quelqu'un qui jouait déjà.
        const clash = await findAlignmentClash(tx, m.interclubId, mid, p);
        if (clash !== null) {
          throw new HttpError(
            400,
            `${p.homeDisplayName} dispute déjà le match n° ${clash} de cette rencontre`,
          );
        }
        data.homeUser = p.homeUserId ? { connect: { id: p.homeUserId } } : { disconnect: true };
        data.homeGuest = p.homeGuestId ? { connect: { id: p.homeGuestId } } : { disconnect: true };
        data.homeDisplayName = p.homeDisplayName;
      }
      if (typeof awayName === "string" && awayName.trim()) {
        data.awayName = awayName.trim().slice(0, MAX_PLAYER_NAME_LEN);
      }
      if (homeColor !== undefined) data.homeColor = normalizeColor(homeColor);
      if (awayColor !== undefined) data.awayColor = normalizeColor(awayColor);

      if (parsedGames) {
        const winner = sequenceWinner(parsedGames, m.interclub.bestOf);
        let home = 0;
        let away = 0;
        for (const g of parsedGames) {
          if (g.home > g.away) home += 1;
          else away += 1;
        }
        // Remplacement intégral : on efface avant de réécrire.
        await tx.interclubGame.deleteMany({ where: { matchId: mid } });
        if (parsedGames.length) {
          await tx.interclubGame.createMany({
            data: parsedGames.map((g, i) => ({
              matchId: mid,
              number: i + 1,
              pointsHome: g.home,
              pointsAway: g.away,
              finishedAt: new Date(),
            })),
          });
        }
        data.gamesHome = parsedGames.length ? home : null;
        data.gamesAway = parsedGames.length ? away : null;
        data.status = winner ? "done" : parsedGames.length ? "live" : "pending";
        // Le match n'est plus en cours : la prise de marquage n'a plus lieu d'être.
        if (winner) {
          data.scorer = { disconnect: true };
          data.scorerClaimedAt = null;
          data.liveJson = null;
        }
      }

      // RIEN À ÉCRIRE ⇒ ON N'ÉCRIT PAS.
      //
      // Un corps `{}` — un client qui rejoue sa requête au retour au premier plan, une double
      // soumission — traversait tout : `update` (qui bouscule `updatedAt`), la relecture des
      // simples voisins, la mise à jour de la rencontre, et `interclubChanged()`. Quatre
      // allers-retours Neon et une purge du tag du direct, qui fait relire la requête LOURDE à
      // tous les spectateurs — pour une requête qui ne demande rien.
      //
      // On sort avant d'avoir rien changé. La transaction n'a rien écrit : il n'y a donc ni
      // statut à recaler, ni notification à envoyer, ni cache à invalider.
      if (Object.keys(data).length === 0) return RIEN_ECRIT;

      await tx.interclubMatch.update({ where: { id: mid }, data });

      // Recale le statut de la rencontre dans la MÊME transaction : sinon la liste peut
      // afficher « en cours » alors que le dernier match vient d'être saisi.
      const siblings = await tx.interclubMatch.findMany({
        where: { interclubId: id },
        orderBy: { order: "asc" },
        select: {
          gamesHome: true,
          gamesAway: true,
          status: true,
          homeDisplayName: true,
        },
      });
      const eff = derivedStatus(m.interclub.matchCount, siblings);

      // « La rencontre commence », que le direct était seul à envoyer — alors que le
      // commentaire ci-dessous promet les MÊMES transitions des deux côtés. Un club qui saisit
      // tout a posteriori, précisément le cas que ce raisonnement dit vouloir couvrir, ne le
      // recevait donc jamais.
      //
      // ⚠️ La garde porte sur des MARQUEURS PERSISTANTS, et non sur une comparaison de statut.
      // Le statut d'une rencontre redescend légitimement — vider les jeux d'un simple pour
      // ressaisir le bon score la ramène de `done` à `live` —, et une comparaison réarmait donc
      // les deux transitions à chaque redescente : corriger un score en deux temps annonçait
      // « la rencontre commence » sur une rencontre finie depuis deux heures, puis renvoyait le
      // résultat final à tous les abonnés. Un marqueur ne se réarme pas.
      const fixtureStarted = eff === "live" && m.interclub.startNotifiedAt === null;
      const fixtureNewlyDone = eff === "done" && m.interclub.doneNotifiedAt === null;

      const now = new Date();
      await tx.interclub.update({
        where: { id },
        data: {
          status: eff,
          // Posés DANS la transaction : un rejeu après conflit de sérialisation relit la ligne
          // et retrouve donc la garde fermée si une autre écriture a déjà annoncé.
          ...(fixtureStarted ? { startNotifiedAt: now } : {}),
          ...(fixtureNewlyDone ? { doneNotifiedAt: now } : {}),
        },
      });

      // Une saisie a posteriori notifie les MÊMES transitions que le direct.
      //
      // Une première version ne signalait ici que la fin de rencontre, au motif qu'une
      // saisie tardive est « une correction, pas un direct ». C'était une erreur de
      // raisonnement : un club qui ne se sert jamais de l'écran de marquage ne recevait
      // alors RIEN avant le tout dernier match, y compris pour qui s'était abonné au
      // niveau « détaillé ». Ce qui doit décider, ce n'est pas la route employée, c'est
      // qu'il y ait une information NOUVELLE — d'où les gardes ci-dessous, qui taisent au
      // passage les vraies corrections (rien n'avance, rien ne part). Celles qui portent sur le
      // MATCH comparent l'état lu en début de transaction ; celles qui portent sur la RENCONTRE
      // lisent des marqueurs persistants, une comparaison de statut ne pouvant pas tenir (cf.
      // plus haut).
      // Les noms EFFECTIFS, c'est-à-dire ceux que cette requête vient d'écrire — et non
      // ceux lus en début de transaction. Composer l'équipe et saisir le score d'un même
      // geste est le cas ordinaire : la notification annonçait alors « à désigner c. à
      // désigner » alors que les joueurs venaient d'être choisis.
      const effHome =
        typeof data.homeDisplayName === "string" ? data.homeDisplayName : m.homeDisplayName;
      const effAway = typeof data.awayName === "string" ? data.awayName : m.awayName;

      const gamesGrew = !!parsedGames && parsedGames.length > m.games.length;
      const winner = parsedGames ? sequenceWinner(parsedGames, m.interclub.bestOf) : null;
      const matchNewlyDone = !!winner && m.status !== "done";

      if (!gamesGrew && !matchNewlyDone && !fixtureStarted && !fixtureNewlyDone) return null;

      return {
      ctx: {
        fixtureId: id,
        teamId: m.interclub.teamId,
        teamName: m.interclub.team.name,
        opponent: m.interclub.opponent,
      },
      players: { player: effHome, opponent: effAway },
      gameDone: !winner && gamesGrew && parsedGames ? parsedGames : null,
      matchDone:
        matchNewlyDone && parsedGames
          ? {
              home: parsedGames.filter((g) => g.home > g.away).length,
              away: parsedGames.filter((g) => g.away > g.home).length,
            }
          : null,
      fixtureStarted,
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

  // Rien n'a été écrit : rien à invalider. Purger le tag ferait relire la requête LOURDE du
  // direct à tous les spectateurs pour une requête qui n'a rien demandé.
  if (ev === RIEN_ECRIT) return NextResponse.json({ ok: true });

  interclubChanged();

  // Notifications émises HORS de la transaction et hors de la boucle de réessai : un envoi qui
  // échoue ne doit ni annuler l'écriture (elle est valide), ni déclencher un rejeu (il
  // notifierait deux fois).
  if (ev) {
    // Même ORDRE que le direct : le début de rencontre avant ce qui s'y produit.
    if (ev.fixtureStarted) {
      await notifyFixtureStart(ev.ctx, ev.players.player, ev.players.opponent);
    }
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

  return NextResponse.json({ ok: true });
}
