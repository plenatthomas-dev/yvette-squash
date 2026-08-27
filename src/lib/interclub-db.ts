// Colle entre la base et l'API pour l'interclub. Contrairement à `interclub.ts` (moteur pur),
// ce module connaît Prisma — il ne doit donc JAMAIS être importé depuis un composant client.

import { Prisma } from "@prisma/client";
import { gameWinner, normalizeColor, winGamesFor, type MatchState, type Side } from "./interclub";

export const interclubInclude = {
  team: true,
  matches: {
    orderBy: { order: "asc" },
    include: { games: { orderBy: { number: "asc" } } },
  },
} satisfies Prisma.InterclubInclude;

export type FullInterclub = Prisma.InterclubGetPayload<{ include: typeof interclubInclude }>;

/** Longueurs maximales des champs libres, alignées sur les usages du reste de l'appli. */
export const MAX_OPPONENT_LEN = 60;
export const MAX_PLAYER_NAME_LEN = 40;
export const MAX_SEASON_LEN = 12;
export const MAX_DIVISION_LEN = 30;

/**
 * Une prise de marquage est PÉRIMÉE au-delà de ce délai sans écriture : sinon un téléphone
 * à plat gèlerait le match pour toute la soirée, personne d'autre ne pouvant reprendre.
 */
export const SCORER_STALE_MS = 30 * 60_000;

export function scorerIsStale(claimedAt: Date | null, updatedAt: Date, now: Date = new Date()): boolean {
  if (!claimedAt) return true;
  const last = Math.max(claimedAt.getTime(), updatedAt.getTime());
  return now.getTime() - last > SCORER_STALE_MS;
}

/** Instantané du match en cours, tel que le marqueur l'envoie. Toléré partiel : il vient du client. */
export interface LiveSnapshot {
  current: { home: number; away: number };
  serving: Side | null;
  servingBox: "right" | "left" | null;
  awaitingServeBox: boolean;
}

/**
 * Relit `liveJson`. Tolérant par construction : la colonne peut porter une version plus
 * ancienne du format, ou un JSON tronqué. En cas de doute on renvoie `null` — l'affichage
 * retombe alors sur les jeux terminés, jamais sur un état inventé.
 */
export function parseLive(raw: string | null): LiveSnapshot | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const cur = o.current as Record<string, unknown> | undefined;
    const home = Number(cur?.home);
    const away = Number(cur?.away);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;
    const serving = o.serving === "home" || o.serving === "away" ? o.serving : null;
    const box = o.servingBox === "right" || o.servingBox === "left" ? o.servingBox : null;
    return { current: { home, away }, serving, servingBox: box, awaitingServeBox: !!o.awaitingServeBox };
  } catch {
    return null;
  }
}

export function serializeLive(state: MatchState): string {
  const snap: LiveSnapshot = {
    current: state.current,
    serving: state.serving,
    servingBox: state.servingBox,
    awaitingServeBox: state.awaitingServeBox,
  };
  return JSON.stringify(snap);
}

/** Jeux gagnés déduits des jeux TERMINÉS enregistrés (source de vérité du résultat). */
export function gamesWonFrom(games: { pointsHome: number; pointsAway: number }[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const g of games) {
    const w = gameWinner({ home: g.pointsHome, away: g.pointsAway });
    if (w === "home") home += 1;
    else if (w === "away") away += 1;
  }
  return { home, away };
}

/**
 * Score de la RENCONTRE = nombre de matchs gagnés de chaque côté. Un match sans résultat ne
 * compte pour personne : une rencontre en cours affiche donc 1-0 et non 1-3.
 */
export function fixtureScore(matches: { gamesHome: number | null; gamesAway: number | null }[]): {
  home: number;
  away: number;
} {
  let home = 0;
  let away = 0;
  for (const m of matches) {
    if (m.gamesHome === null || m.gamesAway === null) continue;
    if (m.gamesHome > m.gamesAway) home += 1;
    else if (m.gamesAway > m.gamesHome) away += 1;
  }
  return { home, away };
}

/**
 * Statut DÉDUIT de la rencontre, indépendamment de la colonne `status` : tous les matchs ont
 * un résultat ⇒ terminée ; au moins un match commencé ⇒ en cours. La colonne reste la valeur
 * affichée, mais l'API peut la recaler (auto-cicatrisation, comme le tournoi).
 */
export function derivedStatus(
  matchCount: number,
  matches: { gamesHome: number | null; status: string }[],
): "scheduled" | "live" | "done" {
  const done = matches.filter((m) => m.gamesHome !== null).length;
  if (done >= matchCount && matchCount > 0) return "done";
  if (done > 0 || matches.some((m) => m.status === "live")) return "live";
  return "scheduled";
}

/** Vue envoyée au client. Ne contient que du déjà-public : noms d'affichage, scores, couleurs. */
export function serializeInterclub(f: FullInterclub, userId: string | null) {
  const matches = f.matches.map((m) => {
    const live = m.status === "live" ? parseLive(m.liveJson) : null;
    return {
      id: m.id,
      order: m.order,
      homeUserId: m.homeUserId,
      homeDisplayName: m.homeDisplayName,
      awayName: m.awayName,
      // Normalisé à la sortie : les lignes saisies avant le passage au choix libre portent
      // encore une clé de l'ancienne palette, le client n'a pas à connaître les deux formes.
      homeColor: normalizeColor(m.homeColor),
      awayColor: normalizeColor(m.awayColor),
      status: m.status,
      gamesHome: m.gamesHome,
      gamesAway: m.gamesAway,
      games: m.games.map((g) => ({ number: g.number, home: g.pointsHome, away: g.pointsAway })),
      live,
      scorerId: m.scorerId,
      isMine: !!userId && m.scorerId === userId,
      scorerStale: scorerIsStale(m.scorerClaimedAt, m.updatedAt),
      updatedAt: m.updatedAt.toISOString(),
    };
  });

  return {
    id: f.id,
    date: f.date,
    team: { id: f.team.id, name: f.team.name },
    season: f.season,
    division: f.division,
    opponent: f.opponent,
    home: f.home,
    matchCount: f.matchCount,
    bestOf: f.bestOf,
    winGames: winGamesFor(f.bestOf),
    status: derivedStatus(f.matchCount, f.matches),
    score: fixtureScore(f.matches),
    createdById: f.createdById,
    isCreator: !!userId && f.createdById === userId,
    matches,
  };
}
