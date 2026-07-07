import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

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
  const alert = await prisma.slotAlert.upsert({
    where: { userId_date_hm: { userId: session.userId, date, hm } },
    update: { active: true, notifiedAt: null },
    create: { userId: session.userId, date, hm },
  });
  return NextResponse.json(alert);
}
