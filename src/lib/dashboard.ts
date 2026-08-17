// Agrégats du mini-tableau de bord admin (étape 4). Indicateurs « d'un coup d'œil » :
// membres, sessions, alertes, santé ResaMania (via le heartbeat des crons), file d'attente.

import { prisma } from "./db";
import { listCronRuns } from "./cron-run";
import { getFeatures } from "./features-server";

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
    bookingsApp,
    bookingsResa,
    features,
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
    // Adoption de l'appli sur 30 jours glissants : résas encore actives, par origine.
    // On borne sur `startsAt` (le créneau joué) et non `createdAt` : c'est la fenêtre que
    // l'admin a en tête quand il regarde « ce qui s'est réservé ce mois-ci ».
    prisma.booking.count({
      where: { status: "booked", source: "app", startsAt: { gte: thirtyDaysAgo } },
    }),
    prisma.booking.count({
      where: { status: "booked", source: "resamania", startsAt: { gte: thirtyDaysAgo } },
    }),
    getFeatures(),
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
    bookingsApp,
    bookingsResa,
    // Sans le flag `externalBookings`, AUCUNE résa faite hors appli n'est détectée : le compteur
    // `bookingsResa` vaut alors 0 par construction. L'UI doit le dire, sinon un admin lirait
    // « 100 % via l'appli » là où la question n'a simplement jamais été posée.
    externalDetection: features.externalBookings,
    crons: crons.map((c) => ({
      name: c.name,
      lastRunAt: c.lastRunAt.toISOString(),
      ok: c.ok,
      info: c.info,
    })),
  };
}
