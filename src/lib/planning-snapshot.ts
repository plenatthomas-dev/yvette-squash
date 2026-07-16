import { prisma } from "./db";
import { getPlanning } from "./resamania/client";
import type { ResaSession } from "./resamania/types";

// Rafraîchit le snapshot d'une journée depuis ResaMania (qui fait foi pour la disponibilité).
//
// Pourquoi : un compte « email seul » lit TOUJOURS le planning depuis le snapshot, jamais en
// direct (il n'a pas de jeton ResaMania). Quand il agit AU NOM d'un délégant (réserver/annuler),
// l'action part bien chez ResaMania avec le jeton du délégant, mais sa propre vue reste sur
// l'ancien snapshot → le créneau n'apparaît ni réservé ni libéré tant qu'un membre ResaMania
// n'a pas rechargé le planning. Comme la route d'action tient justement le jeton du délégant,
// on s'en sert ici pour réécrire le snapshot du jour concerné, immédiatement.
//
// Best-effort : l'action ResaMania a déjà réussi quand on arrive ici ; un échec de
// rafraîchissement ne doit donc PAS faire échouer la requête (au pire le snapshot reste
// stale jusqu'au prochain passage d'un membre connecté, comme avant ce correctif).
export async function refreshSnapshotFromResa(
  date: string,
  resa: ResaSession,
  updatedById: string,
): Promise<void> {
  try {
    const planning = await getPlanning(date, resa.accessToken);
    // Écriture conditionnelle (comme dans /api/planning) : on évite de réécrire le même gros
    // JSON si rien n'a bougé.
    const payloadJson = JSON.stringify(planning);
    const prev = await prisma.planningSnapshot.findUnique({
      where: { date },
      select: { payloadJson: true },
    });
    if (!prev || prev.payloadJson !== payloadJson) {
      await prisma.planningSnapshot.upsert({
        where: { date },
        update: { payloadJson, updatedById },
        create: { date, payloadJson, updatedById },
      });
    }
  } catch (e) {
    console.error("[snapshot] rafraîchissement post-délégation échoué:", e);
  }
}
