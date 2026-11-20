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
import { importSheetResults, reporterCorrection } from "./interclub-sheet-import";
import { feuilleReconstituee } from "./interclub-team-sheet-db";
import { FEUILLE_POULE } from "./interclub-team-sheet";

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
  /**
   * Simples de rencontres DÉJÀ TERMINÉES mis à jour parce que leur feuille a changé (officielle
   * qui remplace une reconstituée, ou correction de la ligue) — cf. `reporterCorrection`.
   */
  corrected: number;
  /**
   * Feuilles RECONSTITUÉES depuis la poule et les fiches joueurs, faute d'officielle publiée
   * (cf. `feuilleDepuisPoule`). Comptées aussi dans `stored`.
   */
  rebuilt: number;
  /**
   * Rencontres de l'appli COMPLÉTÉES à partir de la feuille officielle (cf.
   * `interclub-sheet-import.ts`) : la ligue avait saisi le score avant nous.
   */
  imported: number;
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
 *
 * UNE FEUILLE RECONSTITUÉE (cf. `feuilleDepuisPoule`) RESTE À RELIRE, fenêtre ou pas : elle
 * n'est qu'un repli, et la feuille officielle doit la remplacer dès que la ligue la publie, même
 * des semaines plus tard. Une requête par rencontre et par passage, bornée par `SHEET_LOOKBACK_DAYS`.
 */
export function sheetDue(f: SheetCandidate, now: Date = new Date()): boolean {
  const today = todayISO(now);
  if (f.date > today) return false;
  if (standingsWindowOpen(f.date, now)) return true;
  if (f.date === today) return false;
  const feuille = lireFeuille(f.snSheetJson);
  if (feuille?.snTieId.startsWith(FEUILLE_POULE)) return true;
  return !feuilleComplete(feuille) || lireCote(f.snSheetSide) === null;
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
  const out: SheetsRefresh = { read: 0, stored: 0, empty: 0, unmatched: 0, failed: 0, imported: 0, rebuilt: 0, corrected: 0 };

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
  if (rencontres.length === 0) {
    // Rien à relire, mais une feuille DÉJÀ rangée peut n'avoir jamais été reportée dans la
    // rencontre (feuille lue avant que l'import n'existe).
    out.imported = await importerSansCasser(teamId, now);
    return out;
  }

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

  // LE REPLI : la feuille officielle publique est vide (ou introuvable) alors que la poule publie
  // déjà les scores. On reconstitue — jamais par-dessus une feuille OFFICIELLE déjà rangée.
  const reconstituer = async (f: (typeof rencontres)[number]): Promise<boolean> => {
    const rangee = lireFeuille(f.snSheetJson);
    if (rangee && !rangee.snTieId.startsWith(FEUILLE_POULE)) return false;
    // Déjà reconstituée : elle n'exige que des simples complets, elle ne s'améliorera pas. On ne
    // la refait pas — seule l'officielle, relue juste avant, a de quoi la remplacer.
    if (rangee) return true;
    try {
      const r = await feuilleReconstituee(snTeamId, f.date, now);
      if (!r) return false;
      await prisma.interclub.update({
        where: { id: f.id },
        data: { snSheetJson: JSON.stringify(r.sheet), snSheetSide: r.side, snSheetAt: new Date() },
      });
      out.stored += 1;
      out.rebuilt += 1;
      return true;
    } catch (e) {
      console.warn("[interclub-sheets] feuille non reconstituée", f.id, e);
      return false;
    }
  };

  let premier = true;
  for (const f of rencontres) {
    if (!premier && delai > 0) await pause(delai);
    premier = false;

    if (!f.snTieId) {
      await reconstituer(f);
      continue;
    }

    out.read += 1;
    const { sheet } = await readTieSheet(f.snTieId);
    if (!sheet) {
      if (!(await reconstituer(f))) out.failed += 1;
      continue;
    }
    if (!feuilleSaisie(sheet)) {
      if (!(await reconstituer(f))) out.empty += 1;
      continue;
    }

    const side = ourSide(sheet, {
      ourCode: codes.get(snTeamId) ?? null,
      opponentCode: f.snOpponentTeamId ? (codes.get(f.snOpponentTeamId) ?? null) : null,
      ourNames,
    });
    if (side === null) out.unmatched += 1;
    const json = JSON.stringify(sheet);
    await prisma.interclub.update({
      where: { id: f.id },
      data: { snSheetJson: json, snSheetSide: side, snSheetAt: new Date() },
    });
    out.stored += 1;

    // LA FEUILLE A CHANGÉ (officielle à la place d'une reconstituée, ou corrigée par la ligue) :
    // la rencontre, peut-être déjà terminée, suit — simple par simple, sans écraser une saisie.
    if (f.snSheetJson && f.snSheetJson !== json) {
      try {
        out.corrected += await reporterCorrection(f.id, f.snSheetJson, f.snSheetSide);
      } catch (e) {
        console.warn("[interclub-sheets] correction non reportée", f.id, e);
      }
    }
  }
  out.imported = await importerSansCasser(teamId, now);
  return out;
}

/** L'import ne fait jamais échouer la relecture des feuilles, déjà rangées. */
async function importerSansCasser(teamId: string, now: Date): Promise<number> {
  try {
    return await importSheetResults(teamId, now);
  } catch (e) {
    console.warn("[interclub-sheets] import des résultats officiels impossible", e);
    return 0;
  }
}

/** « 3 feuille(s) relue(s), 1 vide(s)… » — la même phrase pour les crons et l'admin. */
export function describeSheets(s: SheetsRefresh): string {
  const parts = [`${s.stored} feuille(s) de match relue(s)`];
  if (s.empty) parts.push(`${s.empty} pas encore saisie(s)`);
  if (s.unmatched) parts.push(`${s.unmatched} sans notre côté reconnu`);
  if (s.failed) parts.push(`${s.failed} échec(s)`);
  if (s.corrected) parts.push(`${s.corrected} simple(s) corrigé(s) d'après la ligue`);
  if (s.rebuilt) parts.push(`dont ${s.rebuilt} reconstituée(s) depuis la poule`);
  if (s.imported) parts.push(`${s.imported} rencontre(s) complétée(s) depuis squashnet`);
  return parts.join(", ");
}
