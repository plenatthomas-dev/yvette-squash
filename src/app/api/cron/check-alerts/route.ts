import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { ensureFresh, getPlanning } from "@/lib/resamania/client";
import { pushToUser, pushConfigured } from "@/lib/push";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { fmtTime, toInstant } from "@/lib/time";
import type { ResaIdentity, ResaSession } from "@/lib/resamania/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// Régénère un access token ResaMania valide à partir de la dernière session du joueur.
async function accessTokenForUser(userId: string): Promise<string | null> {
  // Uniquement les sessions ResaMania (avec jeton) : les sessions « email seul » n'en ont pas.
  const s = await prisma.session.findFirst({
    where: { userId, expiresAt: { gt: new Date() }, refreshTokenEnc: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!s || !s.accessToken || !s.refreshTokenEnc || !s.tokenExpiresAt || !s.identityJson) {
    return null;
  }
  try {
    const resa: ResaSession = {
      accessToken: s.accessToken,
      refreshToken: decrypt(s.refreshTokenEnc),
      expiresAt: s.tokenExpiresAt.getTime(),
      identity: JSON.parse(s.identityJson) as ResaIdentity,
    };
    const fresh = await ensureFresh(resa);
    if (fresh.accessToken !== s.accessToken) {
      // Persiste le token rafraîchi pour ne pas le refabriquer à chaque passage.
      await prisma.session
        .update({
          where: { id: s.id },
          data: {
            accessToken: fresh.accessToken,
            refreshTokenEnc: encrypt(fresh.refreshToken),
            tokenExpiresAt: new Date(fresh.expiresAt),
          },
        })
        .catch(() => {});
    }
    return fresh.accessToken;
  } catch {
    return null;
  }
}

// GET /api/cron/check-alerts
// Pour chaque alerte active : interroge le planning du jour visé et, si un terrain est
// redevenu réservable à l'horaire demandé, pousse une notif et désactive l'alerte.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }
  if (!pushConfigured()) {
    await recordCronRun("check-alerts", false, "VAPID non configuré");
    return NextResponse.json({ error: "Clés VAPID non configurées" }, { status: 503 });
  }

  const allAlerts = await prisma.slotAlert.findMany({ where: { active: true } });
  if (allAlerts.length === 0) {
    await recordCronRun("check-alerts", true, "0 alerte active");
    return NextResponse.json({ checked: 0, notified: 0, expired: 0 });
  }

  // Un créneau déjà commencé n'a plus d'intérêt : réserver un terrain pour 18 h à 18 h 05
  // ne sert à rien. On désactive ces alertes SANS notifier (évite la notif « 15 h trop
  // tard » reçue quand le cron ne tournait qu'une fois par jour) et on économise l'appel
  // planning associé. Comparaison en instant absolu via toInstant (DST-safe).
  const now = Date.now();
  const expired: typeof allAlerts = [];
  const alerts: typeof allAlerts = [];
  for (const a of allAlerts) {
    if (new Date(toInstant(`${a.date}T${a.hm}:00`)).getTime() <= now) expired.push(a);
    else alerts.push(a);
  }
  if (expired.length > 0) {
    await prisma.slotAlert.updateMany({
      where: { id: { in: expired.map((a) => a.id) } },
      data: { active: false },
    });
  }
  if (alerts.length === 0) {
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

  for (const [key, group] of groups) {
    const [userId, date] = key.split("|");
    checked += group.length;

    const token = await accessTokenForUser(userId);
    if (!token) continue;

    let freeHm: Set<string>;
    try {
      const planning = await getPlanning(date, token);
      freeHm = new Set<string>();
      for (const slot of planning.slots) {
        // Heure du club (Europe/Paris), comme la clé `hm` stockée à la création de l'alerte
        // (cf. page.tsx onWatch / WeekGrid). Un slice UTC brut décalerait de +2 h l'été et
        // ne matcherait jamais les alertes créées depuis la vue Semaine.
        if (slot.bookable) freeHm.add(fmtTime(slot.startsAt));
      }
    } catch {
      continue;
    }

    for (const a of group) {
      if (!freeHm.has(a.hm)) continue;
      const sent = await pushToUser(userId, {
        title: "Un terrain s'est libéré 🎾",
        body: `${prettyDate(a.date)} à ${a.hm} — tu étais en liste d'attente, file réserver !`,
        url: `/?date=${a.date}&view=day`,
        tag: `alert-${a.id}`,
      });
      await prisma.slotAlert.update({
        where: { id: a.id },
        data: { active: false, notifiedAt: new Date() },
      });
      if (sent > 0) notified++;
    }
  }

  await recordCronRun("check-alerts", true, `${notified} notif(s), ${checked} vérifiée(s)`);
  return NextResponse.json({ checked, notified, expired: expired.length });
}
