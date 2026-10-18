// ============================================================================
//  LES FEUILLES DE MATCH OFFICIELLES : les relire, et savoir LESQUELLES relire.
//
//  Elles sont la source du palmarès des joueurs (`interclub-stats.ts`). Elles se
//  relisent AVEC LE CLASSEMENT DE POULE, par les trois mêmes appelants — la
//  relecture d'après-match, le contrôle du lundi et le bouton de l'admin — et
//  pour la même raison : les deux bougent ensemble, quand la ligue a saisi une
//  journée. Un palmarès qui dirait autre chose que le classement affiché juste
//  au-dessus serait pire que pas de palmarès.
//
//  CE QU'ON RELIT, ET POURQUOI SI PEU. Une équipe joue une dizaine de rencontres
//  par saison ; chacune coûte une requête à squashnet. On ne relit donc que :
//
//    * les rencontres EN FENÊTRE D'APRÈS-MATCH (`standingsWindowOpen`) — c'est
//      là que la saisie fédérale arrive, et qu'elle se corrige ;
//    * les rencontres PASSÉES dont la feuille n'est pas encore COMPLÈTE, ou dont
//      on n'a pas su reconnaître notre côté. C'est ce qui rattrape, au premier
//      passage, toute la saison déjà jouée — puis une saisie tardive.
//
//  Une feuille complète et hors fenêtre ne bouge plus : elle n'est plus relue.
// ============================================================================

import { prisma } from "./db";
import { ourSide } from "./captain-official";
import { feuilleComplete, feuilleSaisie, lireCote, lireFeuille } from "./interclub-stats";
import { loadRosters, refreshRosters } from "./interclub-roster-db";
import { readTieSheet, refreshOwnTieIds } from "./interclub-tie-db";
import { standingsWindowOpen } from "./interclub-standings";
import { todayISO } from "./interclub-gate";
import { shiftISO } from "./interclub";

/**
 * Pause entre deux feuilles. 600 ms, comme la vérification capitaine qui lit la même page :
 * squashnet est un site associatif qui ne nous doit rien.
 */
export const SHEET_DELAI_MS = 600;

/**
 * Jusqu'où remonter pour rattraper une feuille incomplète. Une saison : au-delà, une feuille
 * que la ligue n'a jamais complétée ne le sera plus, et la redemander à chaque passage ne ferait
 * que charger squashnet pour rien.
 */
export const SHEET_LOOKBACK_DAYS = 365;

export interface SheetsRefresh {
  /** Feuilles demandées à squashnet. */
  read: number;
  /** Feuilles enregistrées (au moins un simple saisi). */
  stored: number;
  /** Feuilles atteintes mais encore vides : la ligue n'a rien saisi. Une attente, pas une panne. */
  empty: number;
  /** Feuilles enregistrées dont on n'a pas su reconnaître notre côté — elles ne comptent pas. */
  unmatched: number;
  /** Lectures en échec (squashnet muet, ou rendu qu'on ne sait plus lire). */
  failed: number;
}

/** Une rencontre candidate, réduite à ce qui décide de la relire. */
export interface SheetCandidate {
  date: string;
  snSheetJson: string | null;
  snSheetSide: string | null;
}

/**
 * Cette rencontre doit-elle être relue maintenant ? PUR, testé.
 *
 * Le jour même, rien avant 22 h : la rencontre se joue, la ligue n'a rien à publier.
 */
export function sheetDue(f: SheetCandidate, now: Date = new Date()): boolean {
  const today = todayISO(now);
  if (f.date > today) return false;
  if (standingsWindowOpen(f.date, now)) return true;
  if (f.date === today) return false;
  return !feuilleComplete(lireFeuille(f.snSheetJson)) || lireCote(f.snSheetSide) === null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Relit les feuilles de match d'une équipe qui doivent l'être, et les enregistre.
 *
 * NE JETTE PAS sur l'échec d'une feuille : une rencontre que squashnet sert mal ne prive pas
 * les autres. Une panne de la BASE, elle, remonte, comme pour `refreshTeamStandings`.
 *
 * JAMAIS UNE FEUILLE VIDE PAR-DESSUS UNE FEUILLE LUE. Une feuille publiée ne disparaît pas ;
 * si elle revient vide, c'est la lecture qui a changé, et l'écrire effacerait des matchs du
 * palmarès en silence.
 */
export async function refreshTeamSheets(
  teamId: string,
  opts: { now?: Date; delaiMs?: number } = {},
): Promise<SheetsRefresh> {
  const now = opts.now ?? new Date();
  const delai = opts.delaiMs ?? SHEET_DELAI_MS;
  const out: SheetsRefresh = { read: 0, stored: 0, empty: 0, unmatched: 0, failed: 0 };

  const team = await prisma.interclubTeam.findUnique({
    where: { id: teamId },
    select: { snTeamId: true },
  });
  // Sans `teamid` fédéral, aucune feuille n'est atteignable : rien à faire, et rien d'anormal
  // à signaler ici — l'ancrage manquant se voit déjà dans l'admin.
  if (!team?.snTeamId) return out;
  const snTeamId = team.snTeamId;

  const today = todayISO(now);
  const lire = () =>
    prisma.interclub.findMany({
      where: {
        teamId,
        date: { gte: shiftISO(today, -SHEET_LOOKBACK_DAYS), lte: today },
        // Même règle que la porte du classement : une date prévisionnelle n'a pas eu lieu, sauf
        // si quelqu'un y a saisi un score.
        OR: [{ dateConfirmed: true }, { status: { not: "scheduled" } }],
      },
      select: {
        id: true,
        date: true,
        snTieId: true,
        snOpponentTeamId: true,
        snSheetJson: true,
        snSheetSide: true,
      },
      orderBy: { date: "asc" },
    });

  let rencontres = (await lire()).filter((f) => sheetDue(f, now));
  if (rencontres.length === 0) return out;

  // L'identifiant fédéral de la rencontre n'est que sur NOTRE fiche d'équipe. Une requête pour
  // toute la saison, et seulement s'il en manque un.
  if (rencontres.some((f) => !f.snTieId)) {
    try {
      await refreshOwnTieIds(teamId);
      const ids = new Map((await lire()).map((f) => [f.id, f.snTieId]));
      rencontres = rencontres.map((f) => ({ ...f, snTieId: ids.get(f.id) ?? f.snTieId }));
    } catch {
      // Best-effort : les rencontres sans identifiant sont simplement sautées.
    }
  }

  // Notre fiche d'équipe donne les deux témoins de notre côté : notre sigle et nos inscrits.
  // `refreshRosters` ne sort que si elle date de plus d'une semaine.
  try {
    await refreshRosters([snTeamId]);
  } catch {
    // Une fiche déjà en cache reste exploitable.
  }
  const nôtre = (await loadRosters([snTeamId])).get(snTeamId);
  const ourNames = nôtre?.players.map((p) => p.name) ?? [];

  const codes = new Map(
    (
      await prisma.squashnetTeamRoster.findMany({
        where: {
          snTeamId: {
            in: [snTeamId, ...rencontres.map((f) => f.snOpponentTeamId).filter((v): v is string => !!v)],
          },
        },
        select: { snTeamId: true, code: true },
      })
    ).map((r) => [r.snTeamId, r.code]),
  );

  let premier = true;
  for (const f of rencontres) {
    if (!f.snTieId) continue;
    if (!premier && delai > 0) await pause(delai);
    premier = false;

    out.read += 1;
    const { sheet } = await readTieSheet(f.snTieId);
    if (!sheet) {
      out.failed += 1;
      continue;
    }
    if (!feuilleSaisie(sheet)) {
      out.empty += 1;
      continue;
    }

    const side = ourSide(sheet, {
      ourCode: codes.get(snTeamId) ?? null,
      opponentCode: f.snOpponentTeamId ? (codes.get(f.snOpponentTeamId) ?? null) : null,
      ourNames,
    });
    if (side === null) out.unmatched += 1;
    await prisma.interclub.update({
      where: { id: f.id },
      data: { snSheetJson: JSON.stringify(sheet), snSheetSide: side, snSheetAt: new Date() },
    });
    out.stored += 1;
  }
  return out;
}

/** « 3 feuille(s) relue(s), 1 vide(s)… » — la même phrase pour les crons et l'admin. */
export function describeSheets(s: SheetsRefresh): string {
  const parts = [`${s.stored} feuille(s) de match relue(s)`];
  if (s.empty) parts.push(`${s.empty} pas encore saisie(s)`);
  if (s.unmatched) parts.push(`${s.unmatched} sans notre côté reconnu`);
  if (s.failed) parts.push(`${s.failed} échec(s)`);
  return parts.join(", ");
}
