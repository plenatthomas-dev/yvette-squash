import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/alerts -> mes alertes actives (« préviens-moi si un terrain se libère »).
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const alerts = await prisma.slotAlert.findMany({
    where: { userId: session.userId, active: true },
    orderBy: [{ date: "asc" }, { hm: "asc" }],
  });
  return NextResponse.json(alerts);
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
