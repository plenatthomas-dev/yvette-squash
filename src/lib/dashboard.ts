// Agrégats du mini-tableau de bord admin (étape 4). Indicateurs « d'un coup d'œil » :
// membres, sessions, alertes, santé ResaMania (via le heartbeat des crons), file d'attente.

import { prisma } from "./db";
import { listCronRuns } from "./cron-run";

export async function getDashboard() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 864e5);

  const [
    members,
    disabledMembers,
    activeSessions,
    resaSessions,
    recentLogins,
    activeAlerts,
    pendingRequests,
    blockedEmails,
    crons,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { disabledAt: { not: null } } }),
    // Sessions applicatives encore valides (tous modes confondus).
    prisma.session.count({ where: { expiresAt: { gt: now } } }),
    // Sessions ResaMania utilisables (avec refresh token) : si 0, les crons planning/alertes
    // qui dépendent d'un jeton membre n'ont plus de quoi fonctionner.
    prisma.session.count({ where: { expiresAt: { gt: now }, refreshTokenEnc: { not: null } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: thirtyDaysAgo } } }),
    prisma.slotAlert.count({ where: { active: true } }),
    prisma.emailToken.count({ where: { approvedAt: null, expiresAt: { gt: now } } }),
    prisma.emailBlock.count(),
    listCronRuns(),
  ]);

  return {
    members,
    disabledMembers,
    activeSessions,
    resaSessions,
    recentLogins,
    activeAlerts,
    pendingRequests,
    blockedEmails,
    crons: crons.map((c) => ({
      name: c.name,
      lastRunAt: c.lastRunAt.toISOString(),
      ok: c.ok,
      info: c.info,
    })),
  };
}
