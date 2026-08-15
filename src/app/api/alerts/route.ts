import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  alertsChanged,
  alertHorizonISO,
  alertTodayISO,
  ALERT_MAX_DAYS_AHEAD,
} from "@/lib/alerts-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/alerts -> mes alertes actives (« préviens-moi si un terrain se libère »),
// enrichies pour la liste d'attente (idée D) : `count` = nombre total d'inscrits sur le
// créneau, `position` = mon rang (1 = 1ᵉʳ inscrit, ordre d'arrivée). Aucun nom exposé.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
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
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { date, hm } = await req.json().catch(() => ({}));
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  if (typeof hm !== "string" || !/^\d{2}:\d{2}$/.test(hm)) {
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
