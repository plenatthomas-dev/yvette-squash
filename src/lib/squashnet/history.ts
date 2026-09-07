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

/** La clé unique du point, selon la population. Les deux index coexistent (cf. migration 50). */
function pointWhere(subject: RankingSubject, month: string) {
  return subject.kind === "member"
    ? { userId_month: { userId: subject.id, month } }
    : { guestId_month: { guestId: subject.id, month } };
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
    where: pointWhere(subject, month),
    update: { ...data, fetchedAt: new Date() },
    create: {
      ...data,
      month,
      ...(subject.kind === "member" ? { userId: subject.id } : { guestId: subject.id }),
    },
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
  return new Set(
    rows.map((r) => (r.userId ? `member:${r.userId}:${r.month}` : `guest:${r.guestId}:${r.month}`)),
  );
}

/** La clé de `knownPoints`, telle que l'appelant doit la construire. */
export function pointKey(subject: RankingSubject, month: string): string {
  return `${subject.kind}:${subject.id}:${month}`;
}
