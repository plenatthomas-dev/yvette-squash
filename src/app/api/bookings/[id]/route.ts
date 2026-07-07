import { NextRequest, NextResponse } from "next/server";
import { cancel, findAttendeeId } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// DELETE /api/bookings/{id} -> annule la réservation (chez ResaMania + dans le journal)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (!session.resa) {
    return NextResponse.json(
      { error: "L'annulation d'une réservation nécessite une connexion ResaMania." },
      { status: 403 },
    );
  }
  const resa = session.resa;
  const { id } = await params;
  const booking = await prisma.booking.findUnique({ where: { id } });
  if (!booking || booking.userId !== session.userId) {
    return NextResponse.json({ error: "Réservation introuvable" }, { status: 404 });
  }

  // Rattrapage : si l'attendeeId n'a pas été mémorisé, on le retrouve via l'API.
  let attendeeId = booking.attendeeId;
  if (!attendeeId) {
    attendeeId = await findAttendeeId(resa, booking.classEventId);
    if (attendeeId) {
      await prisma.booking.update({ where: { id }, data: { attendeeId } });
    }
  }
  if (!attendeeId) {
    return NextResponse.json(
      { error: "Référence ResaMania introuvable — annule directement sur ResaMania." },
      { status: 422 },
    );
  }

  const r = await cancel(resa, attendeeId);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 409 });
  }
  await prisma.booking.update({ where: { id }, data: { status: "cancelled" } });
  return NextResponse.json({ ok: true });
}
