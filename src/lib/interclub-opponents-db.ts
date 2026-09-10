// Ce que la base sait des adversaires déjà rencontrés. Le pendant IMPUR de
// `interclub-opponents.ts` : la fusion, la règle d'ordre et le vocabulaire sont là-bas, purs et
// testables sans base ; ici on ne fait qu'aller chercher ce que la fusion attend.
//
// La séparation est celle d'`interclub-order.ts` (pur) et `interclub-roster.ts` (base), et elle
// a la même raison d'être : l'écran de composition importe la règle, jamais la lecture.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  awayLineupConflict,
  estDesigne,
  mergeOpponents,
  type KnownOpponent,
} from "./interclub-opponents";

/** Client minimal — le client global à la création, la transaction quand une écriture en dépend. */
type Db = Pick<Prisma.TransactionClient, "interclub">;

/** Client minimal pour relire les autres simples d'une rencontre. */
type MatchDb = Pick<Prisma.TransactionClient, "interclubMatch">;

/**
 * Profondeur de lecture. Une saison compte cinq à sept rencontres ; deux saisons suffisent
 * largement à connaître une poule, et bornent la requête quoi qu'il arrive.
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
    // Croissant : `mergeOpponents` retient le nom LE PLUS RÉCENT, ce qui n'a de sens que si les
    // rencontres arrivent dans l'ordre.
    orderBy: { date: "asc" },
    take: MAX_RENCONTRES,
    select: {
      opponent: true,
      matches: { select: { awayName: true } },
      official: { select: { checkJson: true } },
    },
  });
  return mergeOpponents(
    rencontres.map((r) => ({
      opponent: r.opponent,
      matches: r.matches,
      checkJson: r.official?.checkJson ?? null,
    })),
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
): Promise<string | null> {
  if (!estDesigne(candidate.awayName)) return null;

  const siblings = await db.interclubMatch.findMany({
    where: { interclubId: fixtureId, id: { not: exceptMatchId } },
    select: { order: true, awayName: true },
  });
  const lines = [...siblings, candidate];
  if (lines.filter((l) => estDesigne(l.awayName)).length < 2) return null;

  return awayLineupConflict(lines, await known());
}
