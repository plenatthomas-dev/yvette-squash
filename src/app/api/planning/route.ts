import { NextRequest, NextResponse } from "next/server";
import { getPlanning } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/planning?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date =
    new URL(req.url).searchParams.get("date") ??
    new Date().toISOString().slice(0, 10);

  try {
    const planning = await getPlanning(date, session.resa.accessToken);

    // Annoter « qui du groupe a réservé » :
    //  1) par correspondance du contactId (marche même si la résa a été faite directement
    //     sur ResaMania, dès lors que la personne s'est connectée une fois à l'appli),
    //  2) sinon via le journal local (réservations faites depuis l'appli).
    const users = await prisma.user.findMany({
      select: { contactId: true, displayName: true },
    });
    const byContact = new Map(users.map((u) => [u.contactId, u.displayName]));

    const bookings = await prisma.booking.findMany({
      where: {
        status: "booked",
        startsAt: {
          gte: new Date(`${date}T00:00:00`),
          lte: new Date(`${date}T23:59:59`),
        },
      },
      include: { user: true },
    });
    const byEvent = new Map(bookings.map((b) => [b.classEventId, b.user.displayName]));

    for (const s of planning.slots) {
      if (s.bookerContactId && byContact.has(s.bookerContactId)) {
        s.bookedBy = byContact.get(s.bookerContactId);
      } else {
        const who = byEvent.get(s.id);
        if (who) s.bookedBy = who;
      }
    }

    return NextResponse.json(planning);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
