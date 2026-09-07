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
  /**
   * Cherchés SANS CONCLURE : squashnet muet, joueur introuvable, homonymes ambigus, licencié
   * ailleurs ce mois-là.
   *
   * ⚠️ CE N'EST PAS DU TRAVAIL RESTANT, et c'est la distinction qui compte pour l'écran : un
   * membre arrivé au club l'an dernier n'aura JAMAIS de mesure sur les mois d'avant. Ces
   * couples-là seront réessayés à chaque passage sans jamais aboutir. Les compter comme
   * « à faire » ferait promettre un « terminé » qui n'arriverait pas.
   */
  unresolved: number;
  /** Écritures base en échec (imputées à la base, jamais à squashnet). */
  failed: number;
  /**
   * Couples (joueur, mois) que ce run n'a PAS ATTEINTS — budget de temps épuisé. C'est le
   * travail que le passage suivant reprendra, et le seul nombre qui doit tomber à zéro.
   */
  remaining: number;
  /** Vrai si le run s'est arrêté sur le budget plutôt qu'au bout de la liste. */
  stopped: boolean;
}

export interface BackfillOptions {
  /** Nombre de périodes à remonter (défaut : `MOIS_PAR_DEFAUT`). */
  months?: number;
  /** Délai entre deux appels réseau (défaut : `DELAI_MS`). 0 en test. */
  delayMs?: number;
  /**
   * Budget de temps, en millisecondes. Au-delà, le run s'ARRÊTE PROPREMENT et rend ce qu'il a
   * fait — il ne se coupe pas au milieu d'une écriture.
   *
   * Il existe pour le chemin INTERACTIF : une fonction Vercel est tuée à soixante secondes, et
   * un run tué en vol ne rend aucun compte-rendu, donc l'admin ne sait pas ce qui a été fait ni
   * s'il doit recliquer. Non borné par défaut, pour le script, qui a tout son temps.
   *
   * C'est la reprise (`knownPoints`) qui rend ce découpage sûr : chaque passage repart là où le
   * précédent s'est arrêté, sans jamais redemander ce qu'il tient déjà.
   */
  budgetMs?: number;
  /** Appelé après chaque mois traité, pour donner à voir l'avancement d'un long run. */
  onMonth?: (month: string, index: number, total: number, result: BackfillResult) => void;
}

const dodo = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Télécharge l'historique du classement de tous les joueurs balayés, sur les N dernières
 * périodes publiées.
 *
 * ⚠️ UN CHARGEMENT COMPLET N'EST PAS UNE ROUTE HTTP. Quarante joueurs sur vingt-quatre mois,
 * c'est un quart d'heure de requêtes espacées, là où une fonction Vercel est coupée à soixante
 * secondes : la première fois, ça se lance depuis `scripts/backfill-rankings.ts`. Le bouton
 * d'admin appelle la MÊME fonction avec un `budgetMs`, et reprend là où il s'était arrêté —
 * c'est le chemin de l'entretien (un nouvel inscrit, un mois qui manque), pas du chargement.
 */
export async function backfillHistory(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const delayMs = opts.delayMs ?? DELAI_MS;
  const debut = Date.now();
  const budgetEpuise = () => opts.budgetMs !== undefined && Date.now() - debut >= opts.budgetMs;

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
    remaining: 0,
    stopped: false,
  };
  if (months.length === 0 || subjects.length === 0) return result;

  const deja = await knownPoints(months);

  boucle: for (const [i, month] of months.entries()) {
    // Le mémo vit le temps D'UN mois : c'est la même recherche d'un mois à l'autre, mais pas
    // la même réponse — la partager donnerait à février le classement de janvier.
    const memo = new Map<string, RankingRow[] | null>();

    for (const subject of subjects) {
      if (deja.has(pointKey(subject, month))) {
        result.already++;
        continue;
      }
      // Le budget se vérifie AVANT d'engager un couple, jamais au milieu : un run coupé entre
      // la réponse de squashnet et son écriture aurait payé la requête pour rien, et le
      // passage suivant la repaierait.
      if (budgetEpuise()) {
        result.stopped = true;
        break boucle;
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

  // Ce qui n'a pas été REGARDÉ, et rien d'autre. Les couples tentés sans conclure (`unresolved`)
  // n'en font pas partie : ils ont été vus, et les compter ici promettrait un « terminé » qui
  // n'arriverait jamais pour un joueur non licencié à l'époque.
  const traites = result.already + result.written + result.unresolved + result.failed;
  result.remaining = months.length * subjects.length - traites;
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
