// Heartbeat des crons (mini-tableau de bord admin, étape 4). Chaque cron appelle
// `recordCronRun` à la fin de son exécution ; le dashboard lit `listCronRuns`.

import { prisma } from "./db";

/**
 * Enregistre le passage d'un cron (upsert : une seule ligne par cron). Best-effort : le suivi
 * ne doit JAMAIS faire échouer le cron lui-même, donc toute erreur est avalée.
 */
export async function recordCronRun(name: string, ok: boolean, info?: string): Promise<void> {
  try {
    await prisma.cronRun.upsert({
      where: { name },
      create: { name, lastRunAt: new Date(), ok, info: info ?? null },
      update: { lastRunAt: new Date(), ok, info: info ?? null },
    });
  } catch {
    /* le heartbeat est secondaire : on n'interrompt pas le cron */
  }
}

/** Tous les passages de crons connus (pour le tableau de bord). */
export async function listCronRuns() {
  return prisma.cronRun.findMany({ orderBy: { name: "asc" } });
}
