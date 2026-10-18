// LES RENCONTRES DE POULE ET LES FICHES JOUEURS, côté base : deux caches de pages fédérales.
//
// Le pendant IMPUR de `squashnet/pool.ts` et `squashnet/player.ts`, sur le patron de
// `interclub-roster-db.ts` : on lit et on écrit une table de cache, rien d'autre. QUAND relire
// appartient aux appelants (`interclub-standings.ts` pour la poule, `interclub-team-sheet.ts`
// pour la relecture à la demande).

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { PoolTie } from "./squashnet/pool";
import { estFicheJoueur, type PlayerHistory } from "./squashnet/player";

type Db = {
  squashnetPool: Pick<Prisma.TransactionClient["squashnetPool"], "findUnique" | "upsert">;
};

type DbJoueur = {
  squashnetPlayer: Pick<Prisma.TransactionClient["squashnetPlayer"], "findUnique" | "upsert">;
};

// ---------------------------------------------------------------------------
//  La poule.
// ---------------------------------------------------------------------------

const estJoueurOuNul = (v: unknown) =>
  v === null || (typeof v === "object" && typeof (v as Record<string, unknown>).name === "string");

function estRencontre(v: unknown): v is PoolTie {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.round === "string" &&
    typeof t.homeCode === "string" &&
    typeof t.awayCode === "string" &&
    Array.isArray(t.lines) &&
    t.lines.every((l) => {
      if (typeof l !== "object" || l === null) return false;
      const x = l as Record<string, unknown>;
      return typeof x.label === "string" && estJoueurOuNul(x.home) && estJoueurOuNul(x.away);
    })
  );
}

/**
 * Les rencontres relues depuis leur colonne texte, ou null si elle ne porte rien d'exploitable.
 *
 * VÉRIFIÉES ET PAS SEULEMENT PARSÉES, comme `lireRoster` : un JSON d'un format antérieur passe
 * `JSON.parse`, puis lève au rendu — où il n'y a pas d'error boundary.
 */
export function lirePoolTies(json: string | null | undefined): PoolTie[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every(estRencontre) ? v : null;
  } catch {
    return null;
  }
}

/** L'ancrage d'une poule — les trois identifiants qu'exige sa lecture (cf. `standings.ts`). */
export interface PoolAnchor {
  snEventId: string;
  snDrawId: string;
  snRoundId: string;
}

/**
 * Range les rencontres d'une poule. `empty` : rien d'écrit.
 *
 * UNE LISTE VIDE N'ÉCRASE RIEN, même règle que le classement : une poule publiée ne perd pas ses
 * rencontres, et un silence du site ne doit pas effacer ce qu'il a déjà dit.
 */
export async function storePoolTies(
  pool: PoolAnchor,
  ties: readonly PoolTie[],
  at: Date,
  db: Db = prisma,
): Promise<"stored" | "empty"> {
  if (ties.length === 0) return "empty";
  const data = {
    snEventId: pool.snEventId,
    snDrawId: pool.snDrawId,
    tiesJson: JSON.stringify(ties),
    fetchedAt: at,
  };
  await db.squashnetPool.upsert({
    where: { snRoundId: pool.snRoundId },
    create: { snRoundId: pool.snRoundId, ...data },
    update: data,
  });
  return "stored";
}

/** Les rencontres connues d'une poule, et quand on les a lues. Ne télécharge rien. */
export async function loadPool(
  snRoundId: string,
  db: Db = prisma,
): Promise<{ ties: PoolTie[]; fetchedAt: Date } | null> {
  const row = await db.squashnetPool.findUnique({
    where: { snRoundId },
    select: { tiesJson: true, fetchedAt: true },
  });
  const ties = lirePoolTies(row?.tiesJson);
  return row && ties ? { ties, fetchedAt: row.fetchedAt } : null;
}

// ---------------------------------------------------------------------------
//  La fiche joueur.
// ---------------------------------------------------------------------------

/** La fiche relue depuis sa colonne texte, ou null. */
export function lireFicheJoueur(json: string | null | undefined): PlayerHistory | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return estFicheJoueur(v) ? v : null;
  } catch {
    return null;
  }
}

/** La fiche connue d'un joueur, et quand on l'a lue. Ne télécharge rien. */
export async function loadPlayer(
  regiid: string,
  db: DbJoueur = prisma,
): Promise<{ player: PlayerHistory; fetchedAt: Date } | null> {
  const row = await db.squashnetPlayer.findUnique({
    where: { regiid },
    select: { json: true, fetchedAt: true },
  });
  const player = lireFicheJoueur(row?.json);
  return row && player ? { player, fetchedAt: row.fetchedAt } : null;
}

/** Range la fiche d'un joueur. */
export async function storePlayer(player: PlayerHistory, at: Date, db: DbJoueur = prisma): Promise<void> {
  const data = { name: player.name, json: JSON.stringify(player), fetchedAt: at };
  await db.squashnetPlayer.upsert({
    where: { regiid: player.regiid },
    create: { regiid: player.regiid, ...data },
    update: data,
  });
}
