import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/presence  { classEventId, startsAt }
// Bascule la présence « asso » du joueur courant sur un créneau : crée la ligne si absente,
// la supprime si présente. Signal purement local — ne touche jamais ResaMania ni le
// réservataire du créneau. Pas de confirmation côté client.
// Exclusivité : comme on ne peut pas être sur 2 terrains au même horaire, s'ajouter sur un
// créneau retire automatiquement une éventuelle présence sur l'autre terrain à la même heure.
// IRI d'un class_event ResaMania, ex. "/lecomplexbures/class_events/25312903".
const CLASS_EVENT_IRI = /^\/[a-z0-9_-]+\/class_events\/\d+$/i;
// Rétention : passé ce délai, plus rien n'affiche ces présences → purge opportuniste.
const RETENTION_DAYS = 30;

export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { classEventId, startsAt } = (await req.json().catch(() => ({}))) as {
    classEventId?: unknown;
    startsAt?: unknown;
  };

  // Validation stricte : la route est ouverte à tout membre connecté, on n'accepte
  // qu'un IRI plausible et un horaire réel — ni créneau passé (marge 1 h pour un
  // match en cours), ni au-delà de l'horizon de réservation. Évite les lignes
  // fantaisistes et le 500 sur date invalide.
  if (typeof classEventId !== "string" || !CLASS_EVENT_IRI.test(classEventId)) {
    return NextResponse.json({ error: "classEventId invalide" }, { status: 400 });
  }
  const dt = new Date(typeof startsAt === "string" ? startsAt : "");
  if (isNaN(dt.getTime())) {
    return NextResponse.json({ error: "startsAt invalide" }, { status: 400 });
  }
  const now = Date.now();
  if (dt.getTime() < now - 3600_000 || dt.getTime() > now + 60 * 864e5) {
    return NextResponse.json({ error: "Créneau passé ou trop lointain" }, { status: 400 });
  }

  // Purge opportuniste des présences anciennes (la table ne doit pas grossir sans fin).
  await prisma.attendance.deleteMany({
    where: { startsAt: { lt: new Date(now - RETENTION_DAYS * 864e5) } },
  });

  const existing = await prisma.attendance.findUnique({
    where: { userId_classEventId: { userId: session.userId, classEventId } },
  });

  if (existing) {
    await prisma.attendance.delete({ where: { id: existing.id } });
    return NextResponse.json({ attending: false });
  }

  // Ajout : on purge d'abord toute présence du joueur au même horaire (autre terrain).
  await prisma.attendance.deleteMany({
    where: { userId: session.userId, startsAt: dt },
  });
  await prisma.attendance.create({
    data: { userId: session.userId, classEventId, startsAt: dt },
  });
  return NextResponse.json({ attending: true });
}
