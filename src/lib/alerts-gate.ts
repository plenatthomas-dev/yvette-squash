// Porte d'entrée BON MARCHÉ du cron d'alertes : « existe-t-il seulement une alerte à
// surveiller ? »
//
// POURQUOI CE MODULE EXISTE
// Le cron `check-alerts` est appelé toutes les ~4 minutes par un cron externe (cron-job.org,
// plage 17 h-22 h), le plan Vercel Hobby plafonnant ses propres crons à un par jour. Or Neon
// suspend son compute après 5 minutes d'inactivité : interroger Postgres à chaque passage le
// maintenait éveillé toute la plage, soit ~6 h/jour ≈ 46 CU-hours/mois pour un quota gratuit de
// 100 (mesuré le 2026-08-15, cf. docs/etude-migration-supabase.md).
//
// La réponse à cette unique question vit donc dans le Data Cache de Vercel — durable, partagé
// entre invocations, et surtout SANS Postgres. Le compute Neon n'est plus réveillé que :
//   • quand une alerte existe réellement (c'est le travail attendu, et c'est rare) ;
//   • une fois par heure, pour rafraîchir la porte (filet de sécurité si une invalidation a
//     été manquée : le retard maximal d'une alerte est alors d'une heure, pas d'un jour) ;
//   • une fois par DÉPLOIEMENT : `unstable_cache` dérive sa clé du source de la fonction, que
//     le bundler réécrit à chaque build. La porte repart donc froide après chaque mise en
//     ligne. Sans conséquence fonctionnelle, mais à savoir si l'on rechiffre la consommation.
//
// LE REPLI EST SÛR, ET IL EST EXPLICITE. Un cache vide rend simplement un « miss » (lecture
// Postgres). Mais le Data Cache peut aussi ÉCHOUER — `unstable_cache` lève hors contexte de
// requête, et laisse remonter les erreurs de son magasin. Comme ces appels sont les premiers
// de la route, une erreur non rattrapée mettrait tout le cron à terre. D'où les try/catch
// ci-dessous : en cas de panne du cache, on retombe sur le comportement d'AVANT ce module
// (lecture directe), jamais sur une alerte perdue.

import { unstable_cache, revalidateTag } from "next/cache";
import { prisma } from "./db";
import { recordCronRun } from "./cron-run";
import { CLUB_TZ } from "./time";

const TAG = "slot-alerts";

/** Filet de sécurité : au pire, la porte se rouvre d'elle-même au bout d'une heure. */
const TTL_S = 3600;

/**
 * Garde-fou de bon sens sur la date d'une alerte — PAS une règle métier.
 *
 * Une alerte à une date absurde (faute de frappe « 2027 », requête forgée) ne se déclencherait
 * jamais mais tiendrait la porte OUVERTE, donc le cron interrogerait Postgres et ResaMania
 * toutes les 4 minutes indéfiniment : exactement le problème que ce module supprime.
 *
 * ⚠️ Cette borne n'est PAS l'horizon de réservation de ResaMania. Mesuré le 2026-08-15 : le
 * planning renvoie encore 48 créneaux tous réservables à J+45. Une borne calée sur le J+14 du
 * préchauffage (`api/cron/warm-planning`) aurait refusé des créneaux parfaitement réservables —
 * c'est un choix de cache, pas une règle du club. On prend donc large : au-delà de 90 jours,
 * ce n'est plus une intention de joueur.
 */
export const ALERT_MAX_DAYS_AHEAD = 90;

/**
 * Date ISO (YYYY-MM-DD) au-delà de laquelle une alerte est refusée, exprimée en heure MURALE
 * DU CLUB.
 *
 * `toLocaleDateString()` sans fuseau rendrait la date du process : sur Vercel (TZ=UTC), entre
 * minuit et 2 h du matin à Paris, on serait encore la veille en UTC et la borne glisserait d'un
 * jour. Le projet a une règle unique sur ce point (cf. `lib/time.ts`, « heure murale du club,
 * indépendante du fuseau du serveur ET du navigateur ») : on s'y conforme, d'autant que cette
 * borne sert aussi à ÉCRIRE en base.
 */
export function alertHorizonISO(now: Date = new Date()): string {
  const aujourdhuiClub = now.toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
  // Arithmétique de calendrier faite à midi UTC : on évite qu'un ±1 h de changement d'heure
  // fasse basculer le résultat d'un jour (ce qu'un `Date.now() + N*86400000` ferait).
  const d = new Date(`${aujourdhuiClub}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ALERT_MAX_DAYS_AHEAD);
  return d.toISOString().slice(0, 10);
}

/** Date du jour en heure du club — borne BASSE des alertes. */
export function alertTodayISO(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

const alertsPendingCached = unstable_cache(
  async (): Promise<boolean> => (await prisma.slotAlert.count({ where: { active: true } })) > 0,
  ["slot-alerts-pending"],
  { tags: [TAG], revalidate: TTL_S },
);

/**
 * Vrai s'il existe au moins une alerte active. Servi par le Data Cache ; ne touche Postgres
 * qu'en cas de miss (première fois, invalidation, TTL écoulé) — ou de panne du cache, auquel
 * cas on lit directement la base : dégradé en coût, jamais en exactitude.
 *
 * LECTURE PURE, volontairement. Une première version posait ici le battement de cœur du cron
 * pour profiter d'une base déjà réveillée. C'était un piège : cette fonction est aussi appelée
 * hors du cron, si bien qu'un MEMBRE pouvait écrire un « passage de cron » indiscernable d'un
 * vrai. Un indicateur de santé ne doit jamais être alimenté par autre chose que ce qu'il
 * surveille.
 */
export async function alertsPending(): Promise<boolean> {
  try {
    return await alertsPendingCached();
  } catch {
    return (await prisma.slotAlert.count({ where: { active: true } })) > 0;
  }
}

const noteCronAliveCached = unstable_cache(
  async (): Promise<number> => {
    // Nom DISTINCT de « check-alerts » : `recordCronRun` fait un upsert sur une ligne unique
    // par nom, donc écrire ici sous le même nom écraserait le « 2 notif(s), 5 vérifiée(s) » du
    // dernier passage utile — l'information de diagnostic la plus précieuse du tableau de bord.
    await recordCronRun("check-alerts-veille", true, "cron externe vivant");
    return Date.now();
  },
  ["slot-alerts-heartbeat"],
  { revalidate: TTL_S },
);

/**
 * Battement de cœur du cron d'alertes — à n'appeler QUE depuis le cron lui-même.
 *
 * Mis en cache avec le même TTL que la porte : l'écriture Postgres n'a lieu qu'une fois par
 * heure, y compris quand le cron passe toutes les 4 minutes sans rien à faire. Sans ça,
 * journaliser chaque passage réveillerait la base — ce que ce module supprime — et ne rien
 * journaliser ferait passer un cron en veille pour un cron mort.
 *
 * Best-effort, comme `recordCronRun` dont il hérite le contrat : une panne du suivi ne doit
 * JAMAIS faire échouer le cron.
 *
 * ⚠️ À connaître : sur `/admin`, la ligne « check-alerts-veille » peut avoir jusqu'à une heure
 * de retard. Un cron réellement arrêté n'est donc détectable qu'après ce délai.
 */
export async function noteCronAlive(): Promise<void> {
  try {
    await noteCronAliveCached();
  } catch {
    /* le battement est secondaire : on n'interrompt pas le cron */
  }
}

/**
 * À appeler dès que le nombre d'alertes ACTIVES a pu changer : création, suppression,
 * expiration, notification, suppression d'un membre (cascade). Sans cet appel, la porte
 * resterait dans son état jusqu'à l'expiration du TTL.
 *
 * ⚠️ Portée réelle : `revalidateTag` n'invalide pas sur-le-champ. Next empile le tag et ne le
 * purge qu'APRÈS la réponse. Inutile donc d'essayer de « forcer » un recalcul dans la même
 * requête : la valeur qu'on écrirait serait balayée par la purge de fin de requête. La fenêtre
 * de course résiduelle (le cron lit 0, un membre insère, le cron écrit `false`) est bornée par
 * le TTL : au pire, cette alerte-là n'est surveillée qu'une heure plus tard.
 */
export function alertsChanged(): void {
  revalidateTag(TAG);
}
