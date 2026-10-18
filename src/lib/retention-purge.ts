// Purge QUOTIDIENNE de tout ce que la note de confidentialité promet d'effacer.
//
// Les purges existantes sont opportunistes : la cloche se vide quand le membre reçoit une
// notification, le fil quand quelqu'un écrit, la modération quand un admin agit. Un club calme
// (l'été, une table que personne ne touche) gardait donc ses données bien au-delà de la durée
// annoncée (audit 2026-10, point 9). Cette fonction tourne en tête de `warm-planning`, chaque
// jour, et tient la promesse quel que soit le trafic. Les purges opportunistes restent : elles
// gardent les tables petites entre deux passages.
//
// Best-effort, table par table : un échec n'empêche ni les suivantes ni le cron.

import { prisma } from "./db";
import {
  FORUM_RETENTION_MS,
  MODERATION_RETENTION_MS,
  NOTIF_STATE_RETENTION_MS,
  SNAPSHOT_RETENTION_DAYS,
} from "./retention";
import { NOTIFICATION_RETENTION_DAYS } from "./notifications-shared";
import { ERROR_REPORT_RETENTION_DAYS } from "./error-report";

const DAY = 864e5;

/** Date « YYYY-MM-DD » (UTC) décalée de `offset` jours — l'ordre lexicographique est chronologique. */
function dayISO(offset: number, now: number): string {
  return new Date(now + offset * DAY).toISOString().slice(0, 10);
}

export type PurgeReport = Record<string, number>;

/** Supprime ce qui a dépassé sa durée de conservation. Rend le nombre de lignes par table. */
export async function purgeRetention(now: number = Date.now()): Promise<PurgeReport> {
  const before = (ms: number) => new Date(now - ms);
  const jobs: [string, () => Promise<{ count: number }>][] = [
    // Planning brut : porte le contactId de tiers non membres (cf. retention.ts).
    ["planningSnapshot", () => prisma.planningSnapshot.deleteMany({ where: { date: { lt: dayISO(-SNAPSHOT_RETENTION_DAYS, now) } } })],
    ["appNotification", () => prisma.appNotification.deleteMany({ where: { createdAt: { lt: before(NOTIFICATION_RETENTION_DAYS * DAY) } } })],
    ["forumMessage", () => prisma.forumMessage.deleteMany({ where: { createdAt: { lt: before(FORUM_RETENTION_MS) } } })],
    ["requestLog", () => prisma.requestLog.deleteMany({ where: { createdAt: { lt: before(MODERATION_RETENTION_MS) } } })],
    ["emailBlock", () => prisma.emailBlock.deleteMany({ where: { createdAt: { lt: before(MODERATION_RETENTION_MS) } } })],
    ["notifDeviceState", () => prisma.notifDeviceState.deleteMany({ where: { updatedAt: { lt: before(NOTIF_STATE_RETENTION_MS) } } })],
    ["webauthnChallengeUse", () => prisma.webauthnChallengeUse.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })],
    ["errorReport", () => prisma.errorReport.deleteMany({ where: { createdAt: { lt: before(ERROR_REPORT_RETENTION_DAYS * DAY) } } })],
  ];
  const report: PurgeReport = {};
  for (const [table, job] of jobs) {
    try {
      report[table] = (await job()).count;
    } catch (e) {
      console.error(`[retention] purge de ${table} impossible`, e);
      report[table] = 0;
    }
  }
  return report;
}

/** Total des lignes supprimées, pour le heartbeat. */
export function purgedTotal(r: PurgeReport): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}
