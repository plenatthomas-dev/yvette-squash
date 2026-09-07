import { getMonths, searchRanking, type RankingRow } from "./client";
import { classifyRanking } from "./match";
import { knownPoints, pointKey, writePoint } from "./history";
import { subjectsToRefresh, type Subject } from "./refresh";

// ============================================================================
//  LE REMPLISSAGE RÉTROACTIF DE L'HISTORIQUE.
//
//  LA DÉCOUVERTE QUI REND CE MODULE POSSIBLE : le sélecteur de période de
//  squashnet (`<select id="month">`) ne liste pas seulement le mois courant, il
//  liste les publications PASSÉES — et l'endpoint de recherche accepte
//  n'importe laquelle d'entre elles à l'identique. Une courbe de deux ans est
//  donc téléchargeable AUJOURD'HUI, au lieu de s'accumuler mois après mois.
//  Sans cela, l'écran de progression aurait été un écran vide pendant deux ans.
//
//  TROIS ÉCONOMIES, dans cet ordre d'importance :
//
//   1. ON NE REDEMANDE PAS CE QU'ON A. Les couples (joueur, mois) déjà captés
//      sont lus d'un coup avant de commencer. Un remplissage interrompu se
//      relance donc sans repayer ce qu'il avait déjà obtenu — et le second
//      passage d'un club à jour ne fait AUCUNE requête.
//   2. UNE RECHERCHE SERT TOUS LES HOMONYMES. La requête porte sur le nom de
//      famille : deux joueurs du même nom (il y en a) partagent la réponse.
//      Le mémo est remis à zéro à chaque mois — c'est la même recherche, mais
//      pas la même réponse.
//   3. ON ESPACE LES APPELS. Voir `DELAI_MS`.
//
//  BEST-EFFORT ET NON ATOMIQUE, comme le rafraîchissement mensuel dont il
//  reprend le verdict (`classifyRanking`) : chaque joueur est indépendant, une
//  panne sur l'un n'interrompt pas le lot.
// ============================================================================

/**
 * Combien de périodes remonter par défaut. Deux ans : c'est l'horizon sur lequel une
 * progression veut dire quelque chose au squash, et la fédération republie douze mois par an.
 */
export const MOIS_PAR_DEFAUT = 24;

/**
 * Délai entre deux appels à squashnet.
 *
 * Ce n'est pas une précaution de politesse abstraite : le remplissage est le SEUL usage de
 * l'appli qui envoie des centaines de requêtes d'affilée à un site associatif qui ne nous a
 * rien promis. Une seconde entre deux appels tient le débit sous celui d'un humain qui
 * pagine — et rend la charge invisible pour eux, ce qui est la condition pour que cette
 * fonctionnalité continue d'exister.
 */
export const DELAI_MS = 1_100;

export interface BackfillResult {
  /** Périodes effectivement balayées, la plus récente en tête. */
  months: string[];
  /** Joueurs passés en revue (membres + joueurs sans compte). */
  subjects: number;
  /** Requêtes réellement envoyées à squashnet (hors mémo et hors points déjà connus). */
  requests: number;
  /** Points écrits ou corrigés. */
  written: number;
  /** Couples (joueur, mois) sautés parce que déjà en base. */
  already: number;
  /** Cherchés sans conclure : squashnet muet, introuvable, homonymes ambigus, joueur parti. */
  unresolved: number;
  /** Écritures base en échec (imputées à la base, jamais à squashnet). */
  failed: number;
}

export interface BackfillOptions {
  /** Nombre de périodes à remonter (défaut : `MOIS_PAR_DEFAUT`). */
  months?: number;
  /** Délai entre deux appels réseau (défaut : `DELAI_MS`). 0 en test. */
  delayMs?: number;
  /** Appelé après chaque mois traité, pour donner à voir l'avancement d'un long run. */
  onMonth?: (month: string, index: number, total: number, result: BackfillResult) => void;
}

const dodo = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Télécharge l'historique du classement de tous les joueurs balayés, sur les N dernières
 * périodes publiées.
 *
 * ⚠️ CE N'EST PAS UNE ROUTE HTTP, et ça ne peut pas l'être : quarante joueurs sur vingt-quatre
 * mois, c'est un quart d'heure de requêtes espacées, là où une fonction Vercel est coupée à
 * soixante secondes. Il se lance depuis `scripts/backfill-rankings.ts`, une fois, à la main —
 * ensuite le cron mensuel suffit à entretenir la courbe.
 */
export async function backfillHistory(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const delayMs = opts.delayMs ?? DELAI_MS;
  const months = (await getMonths()).slice(0, opts.months ?? MOIS_PAR_DEFAUT);
  const subjects = await subjectsToRefresh();
  const result: BackfillResult = {
    months,
    subjects: subjects.length,
    requests: 0,
    written: 0,
    already: 0,
    unresolved: 0,
    failed: 0,
  };
  if (months.length === 0 || subjects.length === 0) return result;

  const deja = await knownPoints(months);

  for (const [i, month] of months.entries()) {
    // Le mémo vit le temps D'UN mois : c'est la même recherche d'un mois à l'autre, mais pas
    // la même réponse — la partager donnerait à février le classement de janvier.
    const memo = new Map<string, RankingRow[] | null>();

    for (const subject of subjects) {
      if (deja.has(pointKey(subject, month))) {
        result.already++;
        continue;
      }
      const rows = await rechercher(subject, month, memo, delayMs, result);
      // `null` = squashnet n'a pas répondu pour cette recherche. On ne conclut rien, et on ne
      // marque rien : le mois reste ouvert, un run ultérieur le reprendra.
      if (rows === null) {
        result.unresolved++;
        continue;
      }
      const verdict = classifyRanking(subject.identity, rows);
      if (verdict.status !== "matched") {
        result.unresolved++;
        continue;
      }
      try {
        await writePoint(subject, verdict.match, month);
        result.written++;
      } catch {
        result.failed++;
      }
    }
    opts.onMonth?.(month, i + 1, months.length, result);
  }
  return result;
}

/**
 * La recherche d'un joueur pour un mois, mémoïsée par terme de recherche.
 *
 * L'ÉCHEC EST MÉMOÏSÉ LUI AUSSI (`null`), et c'est voulu : trois joueurs du même nom de famille
 * ne doivent pas déclencher trois fois la requête qui vient d'échouer. Le mois suivant repartira
 * de zéro, mémo neuf.
 */
async function rechercher(
  subject: Subject,
  month: string,
  memo: Map<string, RankingRow[] | null>,
  delayMs: number,
  result: BackfillResult,
): Promise<RankingRow[] | null> {
  const cached = memo.get(subject.query);
  if (cached !== undefined) return cached;

  // L'attente précède l'appel plutôt que de le suivre : ainsi le dernier appel du lot ne fait
  // pas attendre une seconde pour rien avant de rendre la main.
  if (result.requests > 0) await dodo(delayMs);
  result.requests++;
  let rows: RankingRow[] | null;
  try {
    rows = await searchRanking(subject.query, { month });
  } catch {
    rows = null;
  }
  memo.set(subject.query, rows);
  return rows;
}
