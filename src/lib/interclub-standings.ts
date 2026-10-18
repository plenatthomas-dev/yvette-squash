// ============================================================================
//  LE CLASSEMENT DE POULE : le relire, et savoir QUAND le relire.
//
//  La relecture elle-même (`refreshTeamStandings`) sert trois appelants — le
//  bouton de l'admin, le contrôle hebdomadaire du calendrier et la relecture
//  d'après-match. La règle « zéro ligne n'est pas un classement » vit donc ici,
//  une fois : trois copies finiraient par ne plus dire la même chose.
//
//  LA FENÊTRE D'APRÈS-MATCH (demande du club, 2026-10-16). Le classement ne
//  bouge qu'après une journée, mais la fédération ne le publie pas à heure
//  fixe : le résultat dépend de la saisie des capitaines, le soir même ou trois
//  jours plus tard. On le relit donc toutes les 4 heures à partir de 22 h le
//  soir du match, et pendant les 5 jours qui suivent — dernier passage à 22 h
//  le cinquième jour. La CADENCE appartient au cron externe (cf. la route) ;
//  ce module ne dit que si une fenêtre est ouverte.
// ============================================================================

import { unstable_cache } from "next/cache";
import { prisma } from "./db";
import { fetchStandings } from "./squashnet/standings";
import { INTERCLUB_TAG, todayISO } from "./interclub-gate";
import { shiftISO } from "./interclub";
import { slotMinutes } from "./time";

/** Heure murale (club) à partir de laquelle on relit, le soir même du match. */
export const STANDINGS_FIRST_HOUR = 22;

/** Nombre de jours, APRÈS celui du match, pendant lesquels on continue de relire. */
export const STANDINGS_WINDOW_DAYS = 5;

/**
 * Le classement doit-il être relu à `now`, pour une rencontre jouée le `matchDate` ?
 *
 * Ouvert du jour du match à 22 h jusqu'à la fin du cinquième jour suivant, en heure MURALE du
 * club : le cron passe à heure ronde, et un calcul en UTC décalerait la fenêtre d'une à deux
 * heures selon la saison — assez pour manquer le passage de 22 h le soir du match.
 *
 * La borne haute couvre TOUT le cinquième jour, pas « 22 h pile » : un cron qui part à 22 h 00
 * arrive quelques secondes après, et une borne exacte aurait sauté le dernier passage.
 */
export function standingsWindowOpen(matchDate: string, now: Date = new Date()): boolean {
  const today = todayISO(now);
  if (today === matchDate) {
    return slotMinutes(now.toISOString()) >= STANDINGS_FIRST_HOUR * 60;
  }
  return today > matchDate && today <= shiftISO(matchDate, STANDINGS_WINDOW_DAYS);
}

/** Une rencontre qui peut ouvrir une fenêtre : son équipe et sa date. */
export interface StandingsCandidate {
  teamId: string;
  date: string;
}

/**
 * Les rencontres RÉCENTES OU À VENIR, de toutes les équipes.
 *
 * Toutes les équipes et pas seulement les ancrées : l'ancrage se règle sur une autre route, qui
 * n'invalide pas cette porte. Le filtre sur l'ancrage se fait donc APRÈS, au moment de relire,
 * sur des données fraîches.
 *
 * Une date PRÉVISIONNELLE n'ouvre rien : c'est la date bouchon que la fédération pose sur les
 * journées non planifiées (cf. `dateConfirmed`). Elle n'entre que si quelqu'un y a saisi un
 * score — ce qui prouve qu'elle a eu lieu. Même règle que le bandeau du direct.
 */
async function readCandidates(): Promise<StandingsCandidate[]> {
  return prisma.interclub.findMany({
    where: {
      date: { gte: shiftISO(todayISO(), -STANDINGS_WINDOW_DAYS) },
      OR: [{ dateConfirmed: true }, { status: { not: "scheduled" } }],
    },
    select: { teamId: true, date: true },
  });
}

/**
 * Une journée : le plancher de la liste est calculé à la lecture, et une entrée vieille de
 * moins d'un jour le couvre toujours (il ne fait que reculer). C'est aussi le retard maximal
 * d'une invalidation manquée.
 */
const CANDIDATES_TTL_S = 86_400;

// Même tag que le direct : `interclubChanged()` est déjà appelé par TOUTES les écritures de
// rencontre — création, déplacement, suppression, import du calendrier, saisie de score. Un
// second tag aurait demandé de retrouver chacune d'elles, et d'en oublier une.
const candidatesCached = unstable_cache(readCandidates, ["interclub-standings-candidates"], {
  tags: [INTERCLUB_TAG],
  revalidate: CANDIDATES_TTL_S,
});

/**
 * Les équipes dont le classement doit être relu maintenant.
 *
 * PORTE BON MARCHÉ, comme `alertsPending` : le cron passe six fois par jour toute l'année, et
 * Neon s'endort après 5 minutes. Interroger Postgres à chaque passage réveillerait la base la
 * nuit et tout l'été pour répondre « rien ». La liste vit donc dans le Data Cache ; Postgres
 * n'est réveillé que pour un vrai travail, ou une fois par jour au plus pour rafraîchir la porte.
 *
 * Repli sûr : une panne du CACHE relit la base directement — dégradé en coût, jamais en
 * exactitude.
 */
export async function teamsDueForStandings(now: Date = new Date()): Promise<string[]> {
  let candidates: StandingsCandidate[];
  try {
    candidates = await candidatesCached();
  } catch {
    candidates = await readCandidates();
  }
  const due = new Set<string>();
  for (const c of candidates) {
    if (standingsWindowOpen(c.date, now)) due.add(c.teamId);
  }
  return [...due];
}

/** L'ancrage complet qu'exige la lecture du classement — cf. `lib/squashnet/standings.ts`. */
export interface StandingsAnchor {
  id: string;
  snEventId: string;
  snDrawId: string;
  snRoundId: string;
}

export type StandingsRefresh =
  | { ok: true; rows: number; at: Date }
  /**
   * `unreachable` : squashnet n'a pas répondu. `empty` : poule non publiée, ou ancrage faux.
   * `vanished` : zéro ligne pour une poule DÉJÀ LUE — un classement publié ne disparaît pas,
   * c'est donc le site (ou notre lecture) qui a changé : une panne, pas une attente.
   */
  | { ok: false; reason: "unreachable" | "empty" | "vanished" };

/**
 * Relit le classement de la poule et l'enregistre.
 *
 * En cas d'échec on ne touche à RIEN : mieux vaut un classement daté d'hier, et qui le dit
 * (`snStandingsAt`), qu'un tableau effacé. Et zéro ligne n'est pas un classement vide — c'est
 * une poule non publiée ou un ancrage faux ; l'écrire écraserait un tableau valide par du vide,
 * en silence.
 *
 * Une panne de la BASE, elle, remonte : ce n'est ni « squashnet muet » ni « poule vide », et
 * chaque appelant décide de ce qu'elle lui coûte.
 */
export async function refreshTeamStandings(team: StandingsAnchor): Promise<StandingsRefresh> {
  let rows;
  try {
    rows = await fetchStandings(team.snEventId, team.snDrawId, team.snRoundId);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (rows.length === 0) {
    // Une lecture de plus, seulement dans ce cas rare : la poule avait-elle déjà un classement ?
    // « Pas encore publié » ne vaut qu'en début de saison ; après, c'est l'alarme qu'il faut
    // (audit 2026-10, point 15).
    let known: { snStandingsAt: Date | null } | null = null;
    try {
      known = await prisma.interclubTeam.findUnique({
        where: { id: team.id },
        select: { snStandingsAt: true },
      });
    } catch {
      /* lecture impossible : on garde le verdict prudent, « pas publié » */
    }
    return { ok: false, reason: known?.snStandingsAt ? "vanished" : "empty" };
  }
  const at = new Date();
  await prisma.interclubTeam.update({
    where: { id: team.id },
    data: { snStandingsJson: JSON.stringify(rows), snStandingsAt: at },
  });
  return { ok: true, rows: rows.length, at };
}
