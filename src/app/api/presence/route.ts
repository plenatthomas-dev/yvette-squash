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
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { classEventId, startsAt } = (await req.json()) as {
    classEventId?: string;
    startsAt?: string;
  };
  if (!classEventId || !startsAt) {
    return NextResponse.json({ error: "classEventId/startsAt manquant" }, { status: 400 });
  }

  const existing = await prisma.attendance.findUnique({
    where: { userId_classEventId: { userId: session.userId, classEventId } },
  });

  if (existing) {
    await prisma.attendance.delete({ where: { id: existing.id } });
    return NextResponse.json({ attending: false });
  }

  // Ajout : on purge d'abord toute présence du joueur au même horaire (autre terrain).
  await prisma.attendance.deleteMany({
    where: { userId: session.userId, startsAt: new Date(startsAt) },
  });
  await prisma.attendance.create({
    data: { userId: session.userId, classEventId, startsAt: new Date(startsAt) },
  });
  return NextResponse.json({ attending: true });
}
