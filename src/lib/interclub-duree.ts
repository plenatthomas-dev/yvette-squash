// Durée d'un match de squash. Module PUR (ni prisma, ni next) : les routes s'en servent pour
// poser les heures, les écrans pour les afficher — même contrat que `interclub.ts`.
//
// SEUL LE MARQUAGE EN DIRECT HORODATE. Il est le seul à voir le match se jouer : la saisie après
// coup (`PATCH …/matches/{mid}`) arrive quand tout est fini, et l'heure à laquelle on tape un
// score ne dit rien de l'heure à laquelle il a été joué. Elle ne touche donc à aucune de ces
// heures — une correction (11-5 devenu 11-7) ne change pas la durée d'un match bien mesuré.
//
// DEUX HORLOGES, ET C'EST VOULU. Ce qui est PARTAGÉ — la durée d'un simple d'interclub sur sa
// fiche — prend l'heure du SERVEUR : un téléphone mal réglé de dix minutes la fausserait pour
// tout le monde. Le CHRONO de l'écran de marquage, lui, prend l'heure du téléphone qui marque :
// il doit partir au premier appui, même sans réseau, et début comme fin y viennent du même
// appareil. Les deux suivent les mêmes règles (`liveMatchTimes`), et peuvent différer de
// quelques secondes — le temps d'une synchro.
//
// DANS LE DOUTE, RIEN. Une durée fausse est pire qu'une durée absente : elle se lit comme une
// mesure. Chaque fois que l'heure réelle ne peut pas être connue, on laisse NULL et l'écran se
// tait.

import type { GameScore, MatchState } from "@/lib/interclub";

export type MatchStatus = "pending" | "live" | "done";

/** Les deux heures d'un match : des `Date` côté serveur, des millisecondes au téléphone. */
export interface MatchTimes<T = Date> {
  startedAt: T | null;
  finishedAt: T | null;
}

/**
 * Où en est un match, au sens de la durée : `pending` tant qu'aucun point n'est joué — désigner
 * le serveur à 0-0 n'est pas commencer —, `done` au point décisif. C'est la règle de statut de
 * `PUT …/live`, appliquée à l'état que l'écran de marquage tient en main.
 */
export function matchPhase(s: Pick<MatchState, "status" | "games" | "current">): MatchStatus {
  if (s.status === "done") return "done";
  return s.games.length > 0 || s.current.home > 0 || s.current.away > 0 ? "live" : "pending";
}

/**
 * Au-delà, ce n'est plus un match mais un oubli : un simple resté « en cours » après la soirée,
 * ou un point décisif marqué le lendemain. Le plus long match professionnel connu a duré 2 h 46 ;
 * l'écran n'affiche donc rien au-delà de trois heures plutôt qu'un « 26 h 10 ».
 */
export const MAX_MATCH_MS = 3 * 3_600_000;

/** Même garde pour la rencontre entière : une soirée, pas deux. */
export const MAX_FIXTURE_MS = 8 * 3_600_000;

/**
 * Heures d'un simple après une écriture du marquage en direct.
 *
 * - DÉBUT : posé au passage `pending` → `live`, c'est-à-dire au premier point (un 0-0 où l'on a
 *   seulement désigné le serveur reste `pending`, cf. `enJeu` dans la route). Il ne bouge plus
 *   ensuite, sauf si le match retombe à `pending` (le premier point annulé) : le suivant le
 *   repose.
 *
 *   ⚠️ Si cette PREMIÈRE écriture porte déjà un jeu terminé, le premier point date d'avant elle :
 *   le téléphone comptait hors ligne et ne s'est synchronisé qu'après coup (le marqueur envoie au
 *   plus toutes les 5 s — aucun jeu ne tient dans ce délai). L'heure réelle est perdue : NULL.
 *
 *   Un match déjà `live` sans début connu (score saisi après coup, puis repris en direct) le
 *   reste : on ne sait pas quand il a commencé.
 *
 * - FIN : posée au passage à `done`, effacée si le marqueur annule le point décisif. Un renvoi
 *   du même état (reprise après coupure) ne la déplace pas.
 *
 * Générique sur le type de l'heure : la route y passe des `Date`, l'écran de marquage des
 * millisecondes (`Date.now()`), qui se rangent telles quelles dans `localStorage`.
 */
export function liveMatchTimes<T>(
  prev: { status: string } & MatchTimes<T>,
  next: { status: MatchStatus; games: number },
  now: T,
): MatchTimes<T> {
  if (next.status === "pending") return { startedAt: null, finishedAt: null };
  const startedAt = prev.status === "pending" ? (next.games === 0 ? now : null) : prev.startedAt;
  const finishedAt =
    next.status === "done" ? (prev.status === "done" ? prev.finishedAt : now) : null;
  return { startedAt, finishedAt };
}

export interface StoredGameTime {
  pointsHome: number;
  pointsAway: number;
  finishedAt: Date | null;
}

/**
 * Heure de fin de chaque jeu, pour une liste réécrite par le marquage en direct.
 *
 * Les routes effacent et recréent tous les jeux à chaque jeu terminé ; elles leur donnaient à
 * tous l'heure de l'écriture, si bien que chaque jeu portait celle du DERNIER. Un jeu inchangé
 * garde désormais la sienne, et seul le nouveau prend l'heure courante.
 *
 * « Nouveau » s'entend aussi d'un jeu dont le score a changé : le point décisif annulé puis
 * rejoué entre deux envois donne un 12-10 là où la base avait 11-9 — c'est bien maintenant qu'il
 * s'est fini.
 *
 * Plusieurs jeux nouveaux d'un coup : le téléphone était hors ligne, ces jeux sont finis depuis
 * un moment qu'on ne connaît pas → NULL.
 */
export function liveGameTimes(
  prev: readonly StoredGameTime[],
  next: readonly GameScore[],
  now: Date,
): (Date | null)[] {
  const kept = next.map((g, i) => {
    const p = prev[i];
    return p && p.pointsHome === g.home && p.pointsAway === g.away ? p : null;
  });
  const fresh = kept.filter((k) => k === null).length;
  return kept.map((k) => (k ? k.finishedAt : fresh === 1 ? now : null));
}

/**
 * Même chose pour la saisie après coup : un jeu CORRIGÉ garde l'heure à laquelle il s'est
 * réellement fini, un jeu AJOUTÉ n'en a pas.
 */
export function correctedGameTimes(
  prev: readonly StoredGameTime[],
  next: readonly GameScore[],
): (Date | null)[] {
  return next.map((_, i) => prev[i]?.finishedAt ?? null);
}

// --- Affichage -------------------------------------------------------------

/**
 * Temps de jeu en millisecondes, du premier point à la fin — ou à `now` tant que le match n'est
 * pas fini. NULL sans début, ou quand le résultat n'est pas plausible (cf. `MAX_MATCH_MS`).
 */
export function elapsedMs(startedAt: number | null, finishedAt: number | null, now: number): number | null {
  if (startedAt === null) return null;
  const ms = (finishedAt ?? now) - startedAt;
  if (!Number.isFinite(ms) || ms > MAX_MATCH_MS) return null;
  // Négatif : horloge du téléphone en retard sur le serveur, au tout début du match.
  return Math.max(0, ms);
}

export interface TimedMatch {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Durée d'un simple en millisecondes : terminé → fin moins début ; en cours → maintenant moins
 * début. NULL quand on ne sait pas (cf. `elapsedMs`).
 */
export function matchDurationMs(m: TimedMatch, now: number): number | null {
  if (!m.startedAt) return null;
  const start = Date.parse(m.startedAt);
  if (m.status === "live") return elapsedMs(start, null, now);
  if (m.status === "done" && m.finishedAt) return elapsedMs(start, Date.parse(m.finishedAt), now);
  return null;
}

/**
 * Durée de la rencontre : du premier point du premier simple au point décisif du dernier.
 *
 * Seulement quand TOUS les simples sont terminés et mesurés : un seul saisi après coup, et l'on
 * ne sait plus où la soirée commence ni où elle finit.
 */
export function fixtureDurationMs(matches: readonly TimedMatch[]): number | null {
  if (matches.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const m of matches) {
    if (m.status !== "done" || matchDurationMs(m, 0) === null) return null;
    first = Math.min(first, Date.parse(m.startedAt as string));
    last = Math.max(last, Date.parse(m.finishedAt as string));
  }
  const ms = last - first;
  return ms > MAX_FIXTURE_MS ? null : ms;
}

/** 42 min · 1 h 05. Arrondi à la minute, jamais « 0 min » : un match qui commence dure déjà. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")}`;
}
