// Ce que la base sait des adversaires déjà rencontrés. Le pendant IMPUR de
// `interclub-opponents.ts` : la fusion, la règle d'ordre et le vocabulaire sont là-bas, purs et
// testables sans base ; ici on ne fait qu'aller chercher ce que la fusion attend.
//
// La séparation est celle d'`interclub-order.ts` (pur) et `interclub-roster.ts` (base), et elle
// a la même raison d'être : l'écran de composition importe la règle, jamais la lecture.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  awayAlignmentClash,
  awayLineupConflict,
  estDesigne,
  mergeOpponents,
  type KnownOpponent,
} from "./interclub-opponents";
import { loadRosters } from "./interclub-roster-db";

/** Client minimal — le client global à la création, la transaction quand une écriture en dépend. */
type Db = Pick<Prisma.TransactionClient, "interclub" | "squashnetTeamRoster">;

/** Client minimal pour relire les autres simples d'une rencontre. */
type MatchDb = Pick<Prisma.TransactionClient, "interclubMatch">;

/**
 * Profondeur de lecture : les N rencontres LES PLUS RÉCENTES. Une saison en compte cinq à sept ;
 * quarante couvrent donc largement deux saisons à deux équipes, et bornent la requête quoi
 * qu'il arrive.
 *
 * ⚠️ « Les plus récentes » suppose un tri DÉCROISSANT à la lecture — cf. le commentaire des
 * requêtes. Trié croissant, ce même `take` retient les plus ANCIENNES et fige les menus sur la
 * première saison dès qu'on dépasse ce nombre.
 */
export const MAX_RENCONTRES = 40;

/**
 * Les adversaires connus d'une équipe, lus en base.
 *
 * Même source et même profondeur que `/api/interclub/opponents` : ce que le menu propose est
 * exactement ce que la garde connaît. Deux profondeurs différentes offriraient un joueur que le
 * refus ne saurait pas situer — ou l'inverse, plus déroutant encore.
 */
export async function loadKnownOpponents(teamId: string, db: Db = prisma): Promise<KnownOpponent[]> {
  const rencontres = await db.interclub.findMany({
    where: { teamId },
    // ⚠️ DÉCROISSANT, PUIS REMIS À L'ENDROIT. `take` s'applique APRÈS le tri : en croissant, il
    // retenait les 40 rencontres LES PLUS ANCIENNES, c'est-à-dire exactement celles dont on n'a
    // plus rien à faire. Passé la quarantième rencontre enregistrée — trois saisons à deux
    // équipes —, le menu et la garde se figeaient sur la première année et la poule EN COURS
    // disparaissait, sans un message : un club qu'on affronte ce soir n'aurait proposé personne.
    //
    // Le `reverse()` n'est pas cosmétique : `mergeOpponents` retient le nom LE PLUS RÉCENT, ce
    // qui n'a de sens que si les rencontres lui arrivent de la plus ancienne à la plus récente.
    orderBy: { date: "desc" },
    take: MAX_RENCONTRES,
    select: {
      opponent: true,
      snOpponentTeamId: true,
      matches: { select: { awayName: true } },
      official: { select: { checkJson: true } },
    },
  });
  // Les rosters sont LUS, jamais téléchargés ici : cette fonction sert la garde de composition,
  // c'est-à-dire un chemin où quelqu'un attend devant son écran. Le rafraîchissement est un
  // geste à part (`refreshRosters`), lent et explicite.
  const rosters = await loadRosters(
    rencontres.map((r) => r.snOpponentTeamId).filter((v): v is string => !!v),
    db,
  );
  return mergeOpponents(
    // `reverse()` : lues décroissant (pour retenir les PLUS RÉCENTES), rendues croissant — la
    // fusion en dépend pour que « le nom le plus récent l'emporte » veuille dire quelque chose.
    [...rencontres].reverse().map((r) => ({
      opponent: r.opponent,
      snOpponentTeamId: r.snOpponentTeamId,
      matches: r.matches,
      checkJson: r.official?.checkJson ?? null,
    })),
    rosters,
  );
}

/**
 * L'ordre d'en face serait-il rompu si CE simple recevait CET adversaire ? Le pendant de
 * `findOrderConflict` (`interclub-roster.ts`), pour le camp adverse.
 *
 * C'est ici que le blocage se produit « dès la désignation » : la création d'une rencontre passe
 * par `awayLineupConflict` sur sa composition entière, mais la retouche d'un simple isolé — le
 * geste le plus courant, un soir de rencontre — ne voit que sa propre ligne. Il faut donc relire
 * les autres, et dans la MÊME transaction que l'écriture qu'on autorise : deux capitaines qui
 * composent au même instant doivent voir le même état.
 *
 * Rend `null` sans rien lire si le candidat n'est pas désigné : effacer un nom ne peut pas rompre
 * un ordre, et le refuser empêcherait de corriger une composition fautive.
 *
 * `known` est une FONCTION, pas une liste : nommer le premier adversaire d'une rencontre est le
 * geste le plus courant, et il n'y a alors personne à comparer. Charger ce qu'on sait de la poule
 * pour n'en rien faire coûterait une requête à chaque saisie de nom.
 */
export async function findAwayOrderConflict(
  db: MatchDb,
  fixtureId: string,
  exceptMatchId: string,
  candidate: { order: number; awayName: string },
  known: () => Promise<readonly KnownOpponent[]>,
  /**
   * Le club d'en face — `Interclub.opponent`. OBLIGATOIRE : `known` porte les adversaires de
   * TOUS les clubs déjà affrontés par notre équipe, et sans cette précision un homonyme d'un
   * autre club prêterait son classement à celui qu'on désigne.
   */
  opponent: string,
): Promise<string | null> {
  if (!estDesigne(candidate.awayName)) return null;

  const siblings = await db.interclubMatch.findMany({
    where: { interclubId: fixtureId, id: { not: exceptMatchId } },
    select: { order: true, awayName: true },
  });
  const lines = [...siblings, candidate];
  if (lines.filter((l) => estDesigne(l.awayName)).length < 2) return null;

  return awayLineupConflict(lines, await known(), opponent);
}

/**
 * Cet adversaire dispute-t-il DÉJÀ un autre simple de cette rencontre ? Rend le numéro de ce
 * simple, ou `null`. Le pendant de `findAlignmentClash` (`interclub-roster.ts`) pour le camp
 * d'en face.
 *
 * À appeler DANS la transaction qui écrit, comme ses deux sœurs : deux capitaines qui composent
 * au même instant doivent voir le même état, sans quoi le doublon se glisse entre la lecture et
 * l'écriture.
 *
 * Rend `null` sans rien lire si le candidat n'est pas désigné : effacer un nom ne peut créer
 * aucun doublon, et le refuser empêcherait de corriger une composition fautive.
 */
export async function findAwayAlignmentClash(
  db: MatchDb,
  fixtureId: string,
  exceptMatchId: string,
  candidate: { order: number; awayName: string },
): Promise<number | null> {
  if (!estDesigne(candidate.awayName)) return null;

  // ⚠️ LE FILTRAGE SE FAIT EN MÉMOIRE, PAS EN SQL, et c'est délibéré : la comparaison porte sur
  // `nameKey` (casse, accents et ordre des mots repliés), que la base ne sait pas calculer. Un
  // `where: { awayName }` littéral laisserait passer « Xavier Détry » à côté de « DETRY XAVIER »
  // — exactement le doublon le plus probable, puisqu'il vient d'être tapé deux fois de deux
  // façons. Une rencontre compte quatre à cinq simples : le coût est nul.
  const siblings = await db.interclubMatch.findMany({
    where: { interclubId: fixtureId, id: { not: exceptMatchId } },
    select: { order: true, awayName: true },
  });

  return awayAlignmentClash(siblings, candidate);
}
