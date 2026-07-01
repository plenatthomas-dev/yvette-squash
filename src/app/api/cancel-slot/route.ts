import { NextRequest, NextResponse } from "next/server";
import { cancel, findAttendeeId } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// POST /api/cancel-slot  { classEventId }
// Annule la réservation du joueur courant pour un créneau, en résolvant son attendee
// en direct (marche aussi si la résa n'a pas été faite via l'appli). Sert au clic
// « annuler depuis la grille ».
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { classEventId } = (await req.json()) as { classEventId?: string };
  if (!classEventId) {
    return NextResponse.json({ error: "classEventId manquant" }, { status: 400 });
  }

  const attendeeId = await findAttendeeId(session.resa, classEventId);
  if (!attendeeId) {
    return NextResponse.json(
      { error: "Réservation introuvable côté ResaMania." },
      { status: 404 },
    );
  }

  const r = await cancel(session.resa, attendeeId);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 409 });
  }

  // Aligne le journal local si une résa correspond.
  await prisma.booking.updateMany({
    where: { userId: session.userId, classEventId, status: "booked" },
    data: { status: "cancelled" },
  });

  return NextResponse.json({ ok: true });
}
