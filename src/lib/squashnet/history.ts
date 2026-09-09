import { prisma } from "@/lib/db";
import type { RankingMatch } from "./match";

// ============================================================================
//  L'HISTORIQUE DU CLASSEMENT FÉDÉRAL — une mesure par joueur et par mois.
//
//  `SquashnetRanking` dit OÙ EN EST un joueur ; cette table dit D'OÙ IL VIENT.
//  Deux questions, deux chemins de lecture : l'un chaud (l'annuaire, l'ordre des
//  simples, à chaque affichage), l'autre froid (une courbe qu'on ouvre pour la
//  regarder). D'où deux tables, et ce module qui ne sert QUE la seconde.
//
//  ON N'ÉCRIT QUE CE QU'ON A VU. Aucun point n'est créé pour un mois où le
//  rapprochement n'a pas abouti (squashnet muet, homonymes, joueur parti) : un
//  TROU dans la courbe dit « on ne sait pas », là où une valeur reportée du mois
//  précédent affirmerait une stabilité qu'on n'a pas mesurée. La courbe relie
//  les points connus, elle n'invente pas ceux qui manquent.
//
//  IDEMPOTENT PAR (JOUEUR, MOIS). C'est ce qui rend le remplissage rétroactif et
//  le cron mensuel rejouables autant de fois qu'on veut : repasser sur un mois
//  déjà capté corrige la ligne au lieu d'en empiler une seconde.
// ============================================================================

/**
 * De qui on parle. Structurel et minimal À DESSEIN : `Subject` (refresh.ts) le satisfait sans
 * que ce module ait à l'importer, ce qui garderait les deux fichiers en cycle — refresh écrit
 * les points, et le remplissage rétroactif lit les sujets de refresh.
 */
export interface RankingSubject {
  kind: "member" | "guest";
  id: string;
}

/** La clé unique d'un couple (joueur, mois), selon la population. Les deux index coexistent. */
function sujetWhere(subject: RankingSubject, month: string) {
  return subject.kind === "member"
    ? { userId_month: { userId: subject.id, month } }
    : { guestId_month: { guestId: subject.id, month } };
}

/** Le rattachement d'une ligne à son sujet, à la création. */
function sujetData(subject: RankingSubject) {
  return subject.kind === "member" ? { userId: subject.id } : { guestId: subject.id };
}

/**
 * Consigne (ou corrige) la mesure d'un joueur pour un mois.
 *
 * `fetchedAt` est réécrit à chaque passage : il date la LECTURE, pas la publication — le mois,
 * lui, ne bouge pas. C'est ce qui permet de distinguer un point capté le jour de sa parution
 * d'un point rattrapé deux ans plus tard par le remplissage rétroactif.
 */
export async function writePoint(
  subject: RankingSubject,
  hit: RankingMatch,
  month: string,
): Promise<void> {
  const data = { clt: hit.clt, rang: hit.rang, rangM: hit.rangM, mean: hit.mean };
  await prisma.squashnetRankingPoint.upsert({
    where: sujetWhere(subject, month),
    update: { ...data, fetchedAt: new Date() },
    create: { ...data, month, ...sujetData(subject) },
  });
  // Une mesure EFFACE la marque de recherche vaine qui la précédait. Le cas se produit
  // vraiment : un membre marqué « unknown » parce que son nom était mal orthographié, puis
  // corrigé par un admin et repris. Laisser la marque ne casserait rien (les deux tables
  // s'unissent à la lecture, et le point l'emporte), mais deux lignes se contrediraient — et
  // c'est le genre de contradiction qu'on relit six mois plus tard sans savoir laquelle croire.
  await prisma.squashnetRankingProbe.deleteMany({
    where: subject.kind === "member" ? { userId: subject.id, month } : { guestId: subject.id, month },
  });
}

/**
 * Consigne qu'on a CHERCHÉ ce joueur pour ce mois-là et que squashnet a répondu sans lui.
 *
 * ⚠️ À N'APPELER QUE SUR UNE RÉPONSE REÇUE. Une requête en échec (réseau, 5xx, timeout) n'est
 * pas un verdict : la marquer gèlerait un trou qu'un simple hoquet a créé, et le mois ne serait
 * jamais repris. La distinction vit chez l'appelant (`backfill.ts`), parce que lui seul sait si
 * la réponse est arrivée.
 *
 * Ce que ça rend possible : un remplissage qui SE TERMINE. Sans marque, les couples qui
 * n'aboutiront jamais — un membre entré au club l'an dernier, sur les mois d'avant — étaient
 * redemandés à chaque passage, et le compteur « reste » ne descendait plus.
 */
export async function writeProbe(
  subject: RankingSubject,
  month: string,
  verdict: "moved" | "unknown",
): Promise<void> {
  await prisma.squashnetRankingProbe.upsert({
    where: sujetWhere(subject, month),
    update: { verdict, probedAt: new Date() },
    create: { verdict, month, ...sujetData(subject) },
  });
}

/**
 * Les couples (joueur, mois) DÉJÀ captés, pour ne pas les redemander.
 *
 * C'est ce qui rend le remplissage rétroactif REPRENABLE : interrompu au bout de dix minutes,
 * relancé le lendemain, il ne redemande pas à la fédération les huit cents lignes qu'il tient
 * déjà. Sur deux ans et quarante joueurs, c'est la différence entre un quart d'heure de
 * requêtes et rien du tout.
 *
 * La clé est préfixée par la population : rien n'interdit à un membre et à un invité de porter
 * le même `cuid`… sauf le hasard, ce qui n'est pas une garantie qu'on veut avoir à vérifier.
 */
export async function knownPoints(months: string[]): Promise<Set<string>> {
  if (months.length === 0) return new Set();
  const rows = await prisma.squashnetRankingPoint.findMany({
    where: { month: { in: months } },
    select: { userId: true, guestId: true, month: true },
  });
  return new Set(rows.map(coupleKey));
}

/**
 * Les couples (joueur, mois) qu'il est INUTILE de redemander : ceux qu'on a captés, ET ceux
 * qu'on a cherchés en vain alors que squashnet répondait.
 *
 * C'est la lecture que fait le remplissage, et c'est l'union qui le fait CONVERGER. `knownPoints`
 * seul ne sautait que les mesures obtenues ; les recherches vaines — l'essentiel du travail sur
 * les vieux mois — étaient repayées à chaque passage, si bien que le budget de 45 s de la route
 * d'admin s'épuisait toujours au même endroit et que « reste » ne tombait jamais à zéro.
 *
 * `retryProbes` ignore les marques : c'est la reprise à demander APRÈS avoir corrigé le nom de
 * recherche d'un membre, seul cas où une absence peut se dénouer.
 */
export async function knownCouples(
  months: string[],
  opts: { retryProbes?: boolean } = {},
): Promise<Set<string>> {
  if (months.length === 0) return new Set();
  const [points, probes] = await Promise.all([
    prisma.squashnetRankingPoint.findMany({
      where: { month: { in: months } },
      select: { userId: true, guestId: true, month: true },
    }),
    opts.retryProbes
      ? Promise.resolve([])
      : prisma.squashnetRankingProbe.findMany({
          where: { month: { in: months } },
          select: { userId: true, guestId: true, month: true },
        }),
  ]);
  return new Set([...points, ...probes].map(coupleKey));
}

/**
 * La clé d'une LIGNE lue en base. Elle doit rendre exactement ce que `pointKey` construit depuis
 * un sujet — c'est toute l'utilité de la lecture, et rien dans les types ne l'impose : un
 * préfixe changé d'un côté seulement ne casserait aucune compilation, `deja.has(…)` ne
 * matcherait plus jamais, et chaque passage redemanderait l'intégralité de l'historique en
 * réécrivant des lignes identiques. D'où une fonction partagée, et un test qui confronte les
 * deux (`history.test.ts`).
 */
function coupleKey(r: { userId: string | null; guestId: string | null; month: string }): string {
  return r.userId ? `member:${r.userId}:${r.month}` : `guest:${r.guestId}:${r.month}`;
}

/** La clé de `knownCouples`, telle que l'appelant doit la construire. */
export function pointKey(subject: RankingSubject, month: string): string {
  return `${subject.kind}:${subject.id}:${month}`;
}
