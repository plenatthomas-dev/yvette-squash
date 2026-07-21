import { prisma } from "@/lib/db";
import { getLatestMonth, searchRanking } from "./client";
import { matchRanking } from "./match";

// ============================================================================
//  Rafraîchissement du classement fédéral (squashnet.fr) des membres OPT-IN de
//  l'annuaire (`listed`). Cœur PARTAGÉ entre le cron mensuel (warm-rankings) et
//  le bouton admin « Rafraîchir les classements » (déclenchement manuel).
//
//  Pour chaque membre : recherche par nom, rapprochement SÛR (nom + club) ;
//  upsert si trouvé, suppression du classement obsolète sinon. Séquentiel (doux
//  pour squashnet), idempotent.
// ============================================================================

export interface RefreshResult {
  /** Période de classement ciblée, ex. "2026-07-07". Null si squashnet n'en renvoie aucune. */
  month: string | null;
  /** Nombre de membres listés passés en revue. */
  members: number;
  /** Classements rapprochés puis upsertés. */
  matched: number;
  /** Classements devenus obsolètes puis retirés. */
  cleared: number;
}

/**
 * Rafraîchit le classement de tous les membres listés. Ne lève pas sur une erreur ponctuelle
 * squashnet (timeout, 5xx) : le membre concerné est simplement sauté, on n'écrase rien.
 * Renvoie `month: null` sans rien toucher si la période de classement est introuvable.
 */
export async function refreshRankings(): Promise<RefreshResult> {
  const month = await getLatestMonth();
  if (!month) {
    return { month: null, members: 0, matched: 0, cleared: 0 };
  }

  // On matche sur le VRAI nom (displayName), jamais le pseudo (nickname).
  const members = await prisma.user.findMany({
    where: { listed: true },
    select: { id: true, displayName: true },
  });

  let matched = 0;
  let cleared = 0;
  for (const m of members) {
    const name = m.displayName.trim();
    if (!name) continue;
    // displayName = « Prénom Nom » → on interroge squashnet par le dernier mot (≈ nom de
    // famille) ; la recherche fait un « contient » sur « NOM PRÉNOM », donc l'ordre importe peu.
    const tokens = name.split(/\s+/);
    const query = tokens[tokens.length - 1];
    try {
      const rows = await searchRanking(query, { month });
      const hit = matchRanking({ givenName: "", familyName: name }, rows);
      if (hit) {
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
      } else {
        // Plus de rapprochement sûr → on retire un éventuel classement devenu obsolète.
        const del = await prisma.squashnetRanking.deleteMany({ where: { userId: m.id } });
        cleared += del.count;
      }
    } catch {
      // Erreur ponctuelle squashnet (timeout, 5xx) → on n'écrase rien, on continue.
    }
  }

  return { month, members: members.length, matched, cleared };
}
