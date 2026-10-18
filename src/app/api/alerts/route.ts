import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  alertsChanged,
  alertHorizonISO,
  alertTodayISO,
  ALERT_MAX_DAYS_AHEAD,
} from "@/lib/alerts-gate";
import { isRealDateISO } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plafond d'alertes ACTIVES par membre — garde-fou, pas règle du club.
 *
 * Chaque alerte active coûte au cron un appel planning ResaMania par (membre, jour) et tient sa
 * porte ouverte (cf. lib/alerts-gate.ts). Sans plafond, un script authentifié pouvait en poser
 * des milliers — une par jour et par horaire sur 90 jours — et faire marteler ResaMania avec le
 * jeton du membre toutes les 4 minutes. Vingt couvre très largement l'usage réel (quelques
 * créneaux convoités dans la semaine) ; au-delà, ce n'est plus une liste d'attente. Non exporté :
 * Next refuse tout export d'un route.ts qui n'est ni une méthode HTTP ni une option de route.
 */
const MAX_ACTIVE_ALERTS_PER_USER = 20;

/**
 * « HH:MM » qui désigne une heure QUI EXISTE. La forme `\d{2}:\d{2}` laissait passer « 12:75 »
 * ou « 99:99 » ; le cron en tirait ensuite `toInstant("…T12:75:00")`, dont `formatToParts`
 * lève `RangeError: Invalid time value` — hors de tout `try`, donc le cron entier tombait à
 * chaque passage, pour tout le club, et l'alerte fautive n'expirait jamais.
 */
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// GET /api/alerts -> mes alertes actives (« préviens-moi si un terrain se libère »),
// enrichies pour la liste d'attente (idée D) : `count` = nombre total d'inscrits sur le
// créneau, `position` = mon rang (1 = 1ᵉʳ inscrit, ordre d'arrivée). Aucun nom exposé.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value, { resa: false });
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const mine = await prisma.slotAlert.findMany({
    where: { userId: session.userId, active: true },
    orderBy: [{ date: "asc" }, { hm: "asc" }],
  });
  if (mine.length === 0) return NextResponse.json([]);

  // Tous les inscrits (ordre d'arrivée) sur les créneaux qui me concernent → compteur + rang.
  const pairs = mine.map((a) => ({ date: a.date, hm: a.hm }));
  const others = await prisma.slotAlert.findMany({
    where: { active: true, OR: pairs },
    orderBy: { createdAt: "asc" },
    select: { userId: true, date: true, hm: true },
  });
  const byPair = new Map<string, string[]>(); // "date|hm" -> userIds dans l'ordre
  for (const o of others) {
    const k = `${o.date}|${o.hm}`;
    const arr = byPair.get(k);
    if (arr) arr.push(o.userId);
    else byPair.set(k, [o.userId]);
  }
  const enriched = mine.map((a) => {
    const list = byPair.get(`${a.date}|${a.hm}`) ?? [];
    const idx = list.indexOf(session.userId);
    return { ...a, count: list.length, position: idx < 0 ? 1 : idx + 1 };
  });
  return NextResponse.json(enriched);
}

// POST /api/alerts { date: "YYYY-MM-DD", hm: "HH:MM" } -> crée/ré-active une alerte.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value, { resa: false });
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { date, hm } = await req.json().catch(() => ({}));
  // Jour RÉEL, pas seulement bien formé : « 2026-10-32 » passe une regex, et les bornes
  // ci-dessous sont des comparaisons de CHAÎNES — elle les franchissait donc aussi, et faisait
  // planter le cron (même mécanisme que l'horaire impossible, cf. HM_RE).
  if (typeof date !== "string" || !isRealDateISO(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  if (typeof hm !== "string" || !HM_RE.test(hm)) {
    return NextResponse.json({ error: "Horaire invalide" }, { status: 400 });
  }
  // Le format seul ne suffit pas. Une date absurde — faute de frappe « 2027 », requête forgée —
  // donnerait une alerte qui ne se déclenche jamais et qui, elle, tiendrait le cron (donc la
  // base Neon) éveillé. Bornes des DEUX côtés : une date passée est tout aussi inutile, et
  // permettrait de provoquer des réveils à volonté. Cf. ALERT_MAX_DAYS_AHEAD.
  if (date < alertTodayISO()) {
    return NextResponse.json({ error: "Ce créneau est déjà passé." }, { status: 400 });
  }
  if (date > alertHorizonISO()) {
    return NextResponse.json(
      { error: `Trop loin : les alertes se posent jusqu'à ${ALERT_MAX_DAYS_AHEAD} jours à l'avance.` },
      { status: 400 },
    );
  }
  // Plafond compté sur les alertes ACTIVES des AUTRES créneaux : réactiver ou reposer une alerte
  // déjà présente ne doit jamais être refusé (l'upsert ne crée alors rien de plus). Le compte et
  // l'upsert ne sont pas atomiques — deux requêtes simultanées peuvent dépasser d'une unité —,
  // sans conséquence pour un garde-fou de cet ordre.
  const actives = await prisma.slotAlert.count({
    where: { userId: session.userId, active: true, NOT: { date, hm } },
  });
  if (actives >= MAX_ACTIVE_ALERTS_PER_USER) {
    return NextResponse.json(
      {
        error: `Tu as déjà ${MAX_ACTIVE_ALERTS_PER_USER} alertes en cours : retires-en une avant d'en poser une nouvelle.`,
      },
      { status: 429 },
    );
  }
  const alert = await prisma.slotAlert.upsert({
    where: { userId_date_hm: { userId: session.userId, date, hm } },
    update: { active: true, notifiedAt: null },
    create: { userId: session.userId, date, hm },
  });
  // Ouvre la porte du cron : sans ça, la surveillance ne démarrerait qu'au bout du TTL
  // (cf. lib/alerts-gate.ts). C'est l'appel qui rend l'alerte réellement active.
  //
  // Une version précédente ajoutait ici un `await alertsPending()` censé « forcer » le
  // recalcul et refermer une fenêtre de course. C'était inutile : `revalidateTag` n'invalide
  // pas sur-le-champ, il empile le tag et Next le purge APRÈS la réponse — la valeur qu'on
  // recalculait était donc écrite puis balayée aussitôt, au prix d'un aller-retour Postgres
  // par inscription. La fenêtre résiduelle est bornée par le TTL et documentée dans
  // `alertsChanged`.
  alertsChanged();
  return NextResponse.json(alert);
}
