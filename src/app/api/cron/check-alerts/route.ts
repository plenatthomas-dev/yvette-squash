import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getResaTokenForUser } from "@/lib/session";
import { getPlanning } from "@/lib/resamania/client";
import { pushToUser, pushConfigured } from "@/lib/push";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, runCron } from "@/lib/cron-run";
import { alertsPending, alertsChanged, alertHorizonISO, noteCronAlive } from "@/lib/alerts-gate";
import { fmtTime, toInstant } from "@/lib/time";
import { BOOK_ACTION } from "@/lib/notification-actions";
import { isResaRefreshTransient } from "@/lib/resamania/errors";
import { serviceAccessToken } from "@/lib/resamania/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s : la limite des fonctions Vercel (Fluid compute, plan Hobby compris). 60 s coupait les
// passes longues en plein milieu — toujours les mêmes membres, ceux de fin de liste.
export const maxDuration = 300;

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Instant (ms) du début du créneau `date` + `hm`, lus en heure du club — ou `null` si la paire
 * ne désigne pas un instant réel. Ne lève JAMAIS : voir l'usage dans le classement de `GET`.
 */
function debutCreneauMs(date: string, hm: string): number | null {
  try {
    const t = new Date(toInstant(`${date}T${hm}:00`)).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// Durée de vie de la notification « terrain libéré » chez le service push. Au-delà du début du
// créneau elle n'a plus d'objet (et le défaut de web-push est de QUATRE SEMAINES : un téléphone
// éteint la recevrait à son réveil, pour un créneau passé depuis longtemps). Plafond d'une heure :
// un terrain libre se reprend vite, une alerte vieille d'une heure est probablement fausse.
// Plancher d'une minute : un TTL de 0 se traduit par « livrer tout de suite ou jeter », ce qui
// perd la notification au moindre téléphone en veille profonde.
const ALERTE_TTL_MIN_S = 60;
const ALERTE_TTL_MAX_S = 3600;

function ttlAlerteS(debutMs: number, now: number): number {
  const s = Math.floor((debutMs - now) / 1000);
  return Math.min(ALERTE_TTL_MAX_S, Math.max(ALERTE_TTL_MIN_S, s));
}

type FreeByHm = Map<string, { id: string; courtName: string; startsAt: string }[]>;

/**
 * Les terrains libres, par horaire : TOUS, et pas seulement le fait qu'il y en ait un. Le
 * bouton « Réserver » de la notification les essaie dans l'ordre — entre l'envoi et le geste,
 * le premier a pu être pris par quelqu'un d'autre.
 */
function freeSlotsByHm(planning: { slots: { id: string; courtName: string; startsAt: string; bookable: boolean }[] }): FreeByHm {
  const out: FreeByHm = new Map();
  for (const slot of planning.slots) {
    if (!slot.bookable) continue;
    // Heure du club (Europe/Paris), comme la clé `hm` stockée à la création de l'alerte
    // (cf. page.tsx onWatch / WeekGrid). Un slice UTC brut décalerait de +2 h l'été et
    // ne matcherait jamais les alertes créées depuis la vue Semaine.
    const hm = fmtTime(slot.startsAt);
    const libre = { id: slot.id, courtName: slot.courtName, startsAt: slot.startsAt };
    const deja = out.get(hm);
    if (deja) deja.push(libre);
    else out.set(hm, [libre]);
  }
  return out;
}

// NB : la récupération du jeton ResaMania d'un joueur passe par `getResaTokenForUser`
// (session.ts), comme le cron keep-alive-delegations. Ce fichier en avait sa PROPRE copie,
// qui oubliait de déchiffrer le jeton lu et de rechiffrer le jeton rafraîchi — voir l'historique.
// Ne pas la refaire : le déchiffrement, le rechiffrement et la sérialisation des refresh
// concurrents vivent à UN seul endroit.

// GET /api/cron/check-alerts
// Pour chaque alerte active : interroge le planning du jour visé et, si un terrain est
// redevenu réservable à l'horaire demandé, pousse une notif et désactive l'alerte.
async function handle(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }
  if (!pushConfigured()) {
    await recordCronRun("check-alerts", false, "VAPID non configuré");
    return NextResponse.json({ error: "Clés VAPID non configurées" }, { status: 503 });
  }

  // Porte d'entrée servie par le Data Cache, PAS par Postgres : ce cron passe toutes les
  // ~4 minutes alors que Neon s'endort après 5, si bien qu'une simple lecture ici suffisait à
  // maintenir la base éveillée en permanence. Cf. `lib/alerts-gate.ts` pour le raisonnement
  // complet. Le repli est sûr : un cache froid relit Postgres, comme avant.
  // Battement de cœur posé par le CRON et lui seul (jamais par une route de membre), et mis en
  // cache pour n'écrire qu'une fois par heure : journaliser chaque passage réveillerait la base
  // toutes les 4 minutes, soit exactement ce qu'on cherche à éviter.
  await noteCronAlive();

  if (!(await alertsPending())) {
    return NextResponse.json({ checked: 0, notified: 0, expired: 0, skipped: true });
  }

  const allAlerts = await prisma.slotAlert.findMany({ where: { active: true } });
  if (allAlerts.length === 0) {
    // La porte disait « il y a des alertes » et il n'y en a plus : le cache était en retard
    // sur la base (invalidation manquée). On le remet d'aplomb tout de suite.
    alertsChanged();
    await recordCronRun("check-alerts", true, "0 alerte active");
    return NextResponse.json({ checked: 0, notified: 0, expired: 0 });
  }

  // Un créneau déjà commencé n'a plus d'intérêt : réserver un terrain pour 18 h à 18 h 05
  // ne sert à rien. On désactive ces alertes SANS notifier (évite la notif « 15 h trop
  // tard » reçue quand le cron ne tournait qu'une fois par jour) et on économise l'appel
  // planning associé. Comparaison en instant absolu via toInstant (DST-safe).
  // On écarte aussi les alertes AU-DELÀ de l'horizon réservable : elles ne se déclencheraient
  // jamais (le planning n'est pas ouvert si loin) mais tiendraient la porte du cron ouverte
  // indéfiniment. Traité comme une expiration : désactivation silencieuse, sans notification.
  const horizon = alertHorizonISO();
  const now = Date.now();
  const expired: typeof allAlerts = [];
  const alerts: typeof allAlerts = [];
  // Début de chaque créneau surveillé, en instant absolu : sert au classement ci-dessous ET au
  // TTL de la notification (inutile de la livrer une fois le créneau commencé).
  const debutMs = new Map<string, number>();
  for (const a of allAlerts) {
    const debut = debutCreneauMs(a.date, a.hm);
    // Une alerte ILLISIBLE (date ou horaire impossible, écrit avant que POST /api/alerts ne
    // valide autre chose que la forme) part en expiration silencieuse. `toInstant` lève sur une
    // telle valeur, et cette boucle est hors de tout `try` : une seule ligne fautive faisait
    // tomber le cron à chaque passage, pour tout le club, sans jamais être désactivée.
    if (debut === null || debut <= now || a.date > horizon) {
      expired.push(a);
    } else {
      debutMs.set(a.id, debut);
      alerts.push(a);
    }
  }
  if (expired.length > 0) {
    await prisma.slotAlert.updateMany({
      where: { id: { in: expired.map((a) => a.id) } },
      data: { active: false },
    });
  }
  if (alerts.length === 0) {
    // Toutes les alertes restantes viennent d'expirer : la porte doit se refermer, sinon on
    // continuerait de réveiller Postgres toutes les 4 minutes pour rien jusqu'au TTL.
    alertsChanged();
    await recordCronRun("check-alerts", true, `${expired.length} expirée(s)`);
    return NextResponse.json({ checked: 0, notified: 0, expired: expired.length });
  }

  // Regroupe par (userId, date) → un seul appel planning par joueur et par jour.
  const groups = new Map<string, typeof alerts>();
  for (const a of alerts) {
    const key = `${a.userId}|${a.date}`;
    const arr = groups.get(key);
    if (arr) arr.push(a);
    else groups.set(key, [a]);
  }

  let checked = 0;
  let notified = 0;
  let deactivated = 0;
  // Alertes dont le membre n'a pas pu être traité À CE PASSAGE faute de jeton ResaMania
  // (rafraîchissement en panne passagère) : elles restent actives et seront revues au passage
  // suivant (~4 min). Compté à part pour que le heartbeat dise « ResaMania toussait » au lieu
  // de laisser croire à une passe complète.
  let reportes = 0;

  // Le planning d'un jour est le même pour tout le club : on le lit avec le compte de service,
  // UNE fois par jour surveillé (et non une fois par membre). Surtout, c'est ce qui sert les
  // comptes « email seul » : sans jeton ResaMania à eux, leur liste d'attente ne se déclenchait
  // jamais (audit 2026-10, point 8). Sans compte de service (non configuré, ou ResaMania en
  // panne au login), on retombe sur le jeton du membre, comme avant.
  const service = await serviceAccessToken();
  const servicePlanning = new Map<string, Promise<FreeByHm | null>>();
  const viaService = (date: string) => {
    if (!service) return Promise.resolve(null);
    let p = servicePlanning.get(date);
    if (!p) {
      p = getPlanning(date, service).then(freeSlotsByHm, () => null);
      servicePlanning.set(date, p);
    }
    return p;
  };

  for (const [key, group] of groups) {
    const [userId, date] = key.split("|");
    checked += group.length;

    let freeByHm = await viaService(date);
    if (!freeByHm) {
      // Jeton déchiffré et rafraîchi si besoin (et rechiffré en base) par session.ts.
      //
      // try/catch PAR MEMBRE : `getResaTokenForUser` LÈVE désormais sur une panne passagère
      // (au lieu de supprimer la session et rendre null). Sans ce filet, la première alerte d'un
      // membre au jeton expiré pendant une panne interrompait TOUTE la passe — les alertes des
      // membres suivants, dont le jeton était peut-être frais, n'étaient plus vérifiées du tout.
      // On saute ce membre pour ce passage, SANS désactiver son alerte : le terrain peut encore
      // se libérer, et le jeton se rafraîchira au prochain tour.
      let resa;
      try {
        resa = await getResaTokenForUser(userId);
      } catch (e) {
        reportes += group.length;
        // Une erreur NON passagère (base…) est rare et mérite d'être vue ; elle ne doit pas
        // pour autant priver les autres membres de leur vérification.
        if (isResaRefreshTransient(e)) {
          console.warn(`[check-alerts] jeton de ${userId} reporté (ResaMania indisponible)`);
        } else {
          console.error(`[check-alerts] jeton de ${userId} illisible, membre sauté:`, e);
        }
        continue;
      }
      if (!resa) continue;

      try {
        freeByHm = freeSlotsByHm(await getPlanning(date, resa.accessToken));
      } catch {
        continue;
      }
    }

    for (const a of group) {
      const libres = freeByHm.get(a.hm);
      if (!libres) continue;
      const quand = `${prettyDate(a.date)} à ${a.hm}`;
      const sent = await pushToUser(userId, {
        title: "Un terrain s'est libéré 🎾",
        body: `${quand} — tu étais en liste d'attente, file réserver !`,
        url: `/?date=${a.date}&view=day`,
        tag: `alert-${a.id}`,
        // Urgence HAUTE : chaque seconde compte face aux autres membres, et une urgence normale
        // laisse Android différer la livraison d'un téléphone en veille (Doze). TTL calé sur le
        // début du créneau, cf. ttlAlerteS.
        // `Date.now()` et non `now` : la passe peut durer (un appel planning par membre et par jour).
        ttl: ttlAlerteS(debutMs.get(a.id) ?? Date.now(), Date.now()),
        urgency: "high",
        // « Réserver » réserve SANS ouvrir l'appli ni redemander confirmation : c'est le geste
        // que la notification réclame, et chaque seconde compte face aux autres membres. Le
        // service worker (public/sw.js) poste à /api/book, qui relit le planning comme pour
        // une réservation faite à l'écran, puis remplace cette notification par le résultat.
        actions: [BOOK_ACTION],
        data: {
          book: {
            quand,
            startsAt: libres[0].startsAt,
            courts: libres.map((s) => ({ id: s.id, name: s.courtName })),
          },
        },
      });
      await prisma.slotAlert.update({
        where: { id: a.id },
        data: { active: false, notifiedAt: new Date() },
      });
      // Compté à part de `notified` : l'alerte est désactivée même si aucun push n'est parti
      // (abonnement expiré). C'est la DÉSACTIVATION qui doit refermer la porte, pas l'envoi.
      deactivated++;
      if (sent > 0) notified++;
    }
  }

  // Des alertes ont été désactivées (expirées ou notifiées) : la porte doit refléter le nouvel
  // état. Un seul appel en fin de passe plutôt qu'un par alerte — l'invalidation est globale.
  if (expired.length > 0 || deactivated > 0) alertsChanged();

  // Rouge quand AUCUNE alerte n'a pu être vérifiée (ResaMania en panne pour tout le monde).
  await recordCronRun(
    "check-alerts",
    !(checked > 0 && reportes === checked),
    `${notified} notif(s), ${checked} vérifiée(s)${reportes ? `, ${reportes} reportée(s)` : ""}`,
  );
  return NextResponse.json({ checked, notified, expired: expired.length, reportes });
}

// Filet commun (cf. lib/cron-run) : une exception laisse une trace `ok: false` au lieu du
// « ok » de la veille.
export const GET = (req: NextRequest) => runCron("check-alerts", () => handle(req));
