// Heartbeat des crons (mini-tableau de bord admin, étape 4). Chaque cron appelle
// `recordCronRun` à la fin de son exécution ; le dashboard lit `listCronRuns`.
//
// Deux trous que l'audit 2026-10 (point 5) a relevés, et que ce module ferme :
//  - un cron qui LÈVE en cours de route ne laissait aucune trace : sa ligne gardait le « ok »
//    de la veille. `runCron` l'enveloppe et écrit l'échec, puis relance l'erreur ;
//  - un cron qui ne PASSE plus du tout restait vert indéfiniment. `CRON_CADENCES` dit à quel
//    rythme chacun doit battre, et `cronHealth` repère les retards — pour /admin et pour
//    `/api/cron/health-summary`, qu'un cron externe interroge chaque jour.

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

/**
 * Exécute le corps d'un cron et garantit qu'une exception laisse une trace `ok: false`.
 * Le corps reste responsable de son heartbeat normal (il connaît le détail à afficher) : ce
 * filet ne couvre que la sortie par exception, qu'il relance telle quelle.
 */
export async function runCron<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordCronRun(name, false, `exception : ${msg.slice(0, 180)}`);
    throw e;
  }
}

/** Tous les passages de crons connus (pour le tableau de bord). */
export async function listCronRuns() {
  return prisma.cronRun.findMany({ orderBy: { name: "asc" } });
}

const H = 3_600_000;

/**
 * Âge maximal toléré du dernier passage de chaque cron, marge comprise. Les crons absents de
 * cette table ne sont pas surveillés : `interclub-standings` ne note que ses passages UTILES
 * (rien hors saison), les lignes `*-manuel` et `backfill-*` sont des gestes d'admin.
 */
export const CRON_CADENCES: Record<string, number> = {
  "warm-planning": 26 * H, // vercel.json : 1×/jour
  "check-alerts": 26 * H, // vercel.json : 1×/jour (+ cron externe toutes les 4 min)
  "check-alerts-veille": 2 * H, // cron externe, heartbeat écrit au plus 1×/h
  "keep-alive-delegations": 26 * H,
  "interclub-availability": 26 * H,
  "interclub-calendar": 8 * 24 * H, // hebdomadaire
  "warm-rankings": 32 * 24 * H, // mensuel (le 8)
};

export type CronHealth = {
  name: string;
  lastRunAt: Date | null;
  ok: boolean;
  info: string | null;
  /** Dernier passage plus vieux que la cadence attendue (ou jamais vu). */
  late: boolean;
};

/**
 * Croise les heartbeats avec les cadences attendues. Un cron attendu qui n'a JAMAIS écrit sa
 * ligne apparaît aussi, en retard : c'est le cas le plus silencieux de tous.
 */
export function cronHealth(
  runs: { name: string; lastRunAt: Date; ok: boolean; info: string | null }[],
  now: number = Date.now(),
  cadences: Record<string, number> = CRON_CADENCES,
): CronHealth[] {
  const seen = new Set(runs.map((r) => r.name));
  const out: CronHealth[] = runs.map((r) => {
    const max = cadences[r.name];
    return { ...r, late: max !== undefined && now - r.lastRunAt.getTime() > max };
  });
  for (const name of Object.keys(cadences)) {
    if (!seen.has(name)) out.push({ name, lastRunAt: null, ok: false, info: "jamais passé", late: true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
