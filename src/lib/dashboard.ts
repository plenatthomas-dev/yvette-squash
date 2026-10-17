// Agrégats du mini-tableau de bord admin (étape 4). Indicateurs « d'un coup d'œil » :
// membres, sessions, alertes, santé ResaMania (via le heartbeat des crons), file d'attente.

import { prisma } from "./db";
import { listCronRuns, cronHealth } from "./cron-run";
import { recentErrors } from "./error-report";
import { getFeatures } from "./features-server";
import { NOTIF_STATE_WINDOW_DAYS, summarizeNotifStates } from "./notif-state";

export async function getDashboard() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 864e5);
  const notifSince = new Date(now.getTime() - NOTIF_STATE_WINDOW_DAYS * 864e5);

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
    notifRows,
    errors,
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
    // État des notifications des appareils ouverts récemment (comptes actifs seulement) :
    // quelques dizaines de lignes pour un club, agrégées ici plutôt qu'en SQL.
    prisma.notifDeviceState.findMany({
      where: { updatedAt: { gte: notifSince }, user: { disabledAt: null } },
      select: { userId: true, permission: true, subscribed: true, platform: true },
    }),
    // Les dernières erreurs non rattrapées (cf. lib/error-report) : best-effort, une table
    // absente (migration pas encore jouée) ne doit pas faire tomber le tableau de bord.
    recentErrors(10).catch(() => []),
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
    notifs: summarizeNotifStates(notifRows),
    errors: errors.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    // `late` : dernier passage plus vieux que la cadence attendue (cf. CRON_CADENCES). Un cron
    // qui ne passe plus restait sinon vert indéfiniment, sur son dernier « ok ».
    crons: cronHealth(crons, now.getTime()).map((c) => ({
      name: c.name,
      lastRunAt: c.lastRunAt?.toISOString() ?? null,
      ok: c.ok,
      info: c.info,
      late: c.late,
    })),
  };
}
