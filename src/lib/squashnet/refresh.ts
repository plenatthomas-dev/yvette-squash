import { prisma } from "@/lib/db";
import { getLatestMonth, searchRanking } from "./client";
import { classifyRanking } from "./match";
import type { RankingRow } from "./client";

// ============================================================================
//  Rafraîchissement du classement fédéral (squashnet.fr) des membres OPT-IN de
//  l'annuaire (`listed`). Cœur PARTAGÉ entre le cron mensuel (warm-rankings) et
//  le bouton admin « Rafraîchir les classements » (déclenchement manuel).
//
//  Pour chaque membre : recherche par nom, verdict SÛR (classifyRanking) ;
//  upsert si trouvé, suppression SEULEMENT sur signal positif de départ, jamais
//  sur un simple « pas trouvé ». Séquentiel (doux pour squashnet), idempotent.
// ============================================================================

// Disjoncteur « suppression en masse ». Le verdict `moved` (nom retrouvé uniquement hors du
// club) supprime le classement. Si BEAUCOUP de membres deviennent `moved` d'un coup, c'est
// presque sûrement un problème SYSTÉMIQUE — squashnet a renommé/re-rendu le libellé du club et
// `classifyRanking` ne reconnaît plus AUCUNE ligne « dans le club » — et non des départs réels.
// Dans ce cas on n'effectue AUCUNE suppression ce run (fail-safe : mieux vaut des classements
// périmés qu'un effacement total). Départs individuels normaux (0-2/mois) : bien en-dessous.
const BULK_MOVE_MIN = 4; // en-dessous de ce nombre absolu, on fait confiance
const BULK_MOVE_RATIO = 0.34; // ET au-delà d'~1/3 des membres balayés → anomalie

export interface RefreshResult {
  /** Période de classement ciblée, ex. "2026-07-07". Null si squashnet n'en renvoie aucune. */
  month: string | null;
  /** Nombre de membres listés passés en revue. */
  members: number;
  /** Classements rapprochés puis upsertés. */
  matched: number;
  /** Classements obsolètes retirés (lignes DB supprimées, sur signal positif de départ). */
  cleared: number;
  /** Membres laissés en l'état, faute de signal fiable (erreur/silence squashnet, ambiguïté,
   *  ou suppression neutralisée par le disjoncteur anti-effacement-massif). */
  skipped: number;
  /** Membres dont l'ÉCRITURE base a échoué (imputé à la base, jamais à squashnet). */
  failed: number;
  /** Vrai si le disjoncteur a neutralisé un lot de suppressions (anomalie systémique probable). */
  bulkMoveBlocked: boolean;
}

/**
 * Rafraîchit le classement de tous les membres listés. Best-effort et NON atomique : chaque
 * membre est indépendant. Une erreur squashnet (timeout, 5xx) → membre `skipped` ; une erreur
 * d'écriture base → membre `failed` (comptée à part, jamais confondue avec un souci squashnet),
 * sans interrompre le reste du lot. Renvoie `month: null` sans rien toucher si la période de
 * classement est introuvable.
 */
export async function refreshRankings(): Promise<RefreshResult> {
  const month = await getLatestMonth();
  if (!month) {
    return { month: null, members: 0, matched: 0, cleared: 0, skipped: 0, failed: 0, bulkMoveBlocked: false };
  }

  // On matche sur le VRAI nom (displayName), jamais le pseudo (nickname). On écarte tout de
  // suite les noms vides : ils ne sont pas évaluables et fausseraient le compteur `members`,
  // le ratio du disjoncteur et le critère « tous ignorés » du heartbeat.
  const listed = await prisma.user.findMany({
    where: { listed: true },
    select: { id: true, displayName: true },
  });
  const members = listed
    .map((m) => ({ id: m.id, name: m.displayName.trim() }))
    .filter((m) => m.name !== "");

  let matched = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = 0;
  // Les suppressions (`moved`) sont DIFFÉRÉES : on décide en fin de passe si le lot est crédible
  // (cf. disjoncteur ci-dessus) avant d'effacer quoi que ce soit.
  const movedIds: string[] = [];

  for (const m of members) {
    const name = m.name;
    // displayName = « Prénom Nom » → on interroge squashnet par le dernier mot (≈ nom de
    // famille) ; la recherche fait un « contient » sur « NOM PRÉNOM », donc l'ordre importe peu.
    const tokens = name.split(/\s+/);
    const query = tokens[tokens.length - 1];

    // 1) Appel réseau squashnet SEUL sous try : un hoquet (timeout, 5xx) → membre `skipped`.
    let rows: RankingRow[];
    try {
      rows = await searchRanking(query, { month });
    } catch {
      skipped++;
      continue;
    }

    // 2) Verdict. On ne SUPPRIME que sur un signal POSITIF (« moved » : nom retrouvé uniquement
    //    hors du club) ; « pas trouvé » (page 2, ambiguïté, réponse vide) est « unknown » → rien.
    const verdict = classifyRanking({ givenName: "", familyName: name }, rows);
    if (verdict.status === "matched") {
      const hit = verdict.match;
      try {
        await prisma.squashnetRanking.upsert({
          where: { userId: m.id },
          update: { clt: hit.clt, rang: hit.rang, licence: hit.licence, cat: hit.cat, club: hit.club, month },
          create: {
            userId: m.id,
            clt: hit.clt,
            rang: hit.rang,
            licence: hit.licence,
            cat: hit.cat,
            club: hit.club,
            month,
          },
        });
        matched++;
      } catch {
        failed++; // panne base : imputée à la base, on continue le lot.
      }
    } else if (verdict.status === "moved") {
      movedIds.push(m.id);
    } else {
      skipped++;
    }
  }

  // 3) Disjoncteur : un lot de `moved` anormalement gros trahit un souci systémique (club
  //    renommé côté squashnet), pas des départs réels → on ne supprime rien ce run.
  const bulkMoveBlocked =
    movedIds.length >= BULK_MOVE_MIN && movedIds.length > members.length * BULK_MOVE_RATIO;
  if (bulkMoveBlocked) {
    skipped += movedIds.length; // suppressions neutralisées → considérées « non concluantes ».
  } else {
    for (const id of movedIds) {
      try {
        const del = await prisma.squashnetRanking.deleteMany({ where: { userId: id } });
        cleared += del.count;
      } catch {
        failed++;
      }
    }
  }

  return { month, members: members.length, matched, cleared, skipped, failed, bulkMoveBlocked };
}

/**
 * Résume un run pour le heartbeat du tableau de bord. `ok` est FAUX si quelque chose cloche
 * vraiment : une écriture base a échoué, le disjoncteur a bloqué des suppressions, ou TOUS les
 * membres ont été ignorés (squashnet muet). Un run où rien n'a bougé mais où squashnet a
 * répondu (aucun changement de classement) reste `ok`.
 */
export function summarizeRefresh(r: RefreshResult): { ok: boolean; info: string } {
  const ok =
    r.failed === 0 && !r.bulkMoveBlocked && (r.members === 0 || r.skipped < r.members);
  const parts = [`${r.matched} rapproché(s)`, `${r.cleared} retiré(s)`, `${r.skipped} ignoré(s)`];
  if (r.failed) parts.push(`${r.failed} échec(s) base`);
  if (r.bulkMoveBlocked) parts.push("suppression en masse BLOQUÉE");
  return { ok, info: parts.join(", ") };
}
