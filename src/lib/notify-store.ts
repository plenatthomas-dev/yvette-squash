// Journal des notifications, affiché sous la cloche.
//
// POURQUOI CE MODULE EXISTE
// Le push ne garantit rien. Permission refusée, notifications coupées au niveau du système,
// iPhone qui n'a pas l'appli sur son écran d'accueil, téléphone éteint au moment de l'envoi :
// dans tous ces cas la notification était perdue DÉFINITIVEMENT, et le membre n'avait aucun
// moyen de savoir qu'elle avait existé. Le journal est le repli — il s'affiche dans l'appli,
// que le push ait abouti ou non.
//
// Il est alimenté depuis le TRANSPORT (`push.ts`) et non depuis chaque appelant : ainsi aucune
// notification ne peut être oubliée au journal, y compris celles ajoutées plus tard.

import { prisma } from "./db";
import { NOTIFICATION_RETENTION_DAYS } from "./notifications-shared";

// Réexporté par commodité pour le code serveur ; la définition vit dans le module partagé.
export { NOTIFICATION_RETENTION_DAYS, NOTIFICATION_PAGE } from "./notifications-shared";

export interface RecordedNotification {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Journalise une notification pour une liste de membres, en une seule écriture.
 *
 * Best-effort et volontairement silencieux : le journal est un confort, il ne doit jamais
 * faire échouer l'envoi qu'il accompagne — encore moins la saisie d'un score qui l'a
 * déclenché. Une purge opportuniste évite d'avoir à installer un cron pour si peu (même
 * motif que le compteur de `api/feedback`).
 */
export async function recordNotifications(
  userIds: readonly string[],
  n: RecordedNotification,
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  try {
    await prisma.appNotification.createMany({
      data: unique.map((userId) => ({
        userId,
        title: n.title.slice(0, 120),
        body: n.body.slice(0, 500),
        url: n.url ?? null,
        tag: n.tag ?? null,
      })),
    });
    // Purge limitée aux membres qu'on vient d'écrire : la clause porte alors sur l'index
    // ([userId, createdAt]), là où un balayage global de `createdAt` — non indexé seul —
    // aurait parcouru toute la table à CHAQUE notification, sur le chemin chaud d'une soirée.
    // Tout membre actif finit purgé de lui-même.
    const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
    await prisma.appNotification.deleteMany({
      where: { userId: { in: unique }, createdAt: { lt: cutoff } },
    });
  } catch {
    /* le journal ne doit jamais faire échouer l'envoi */
  }
}
