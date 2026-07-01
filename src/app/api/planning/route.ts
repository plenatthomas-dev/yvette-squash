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

    // Auto-réconciliation : on confronte le journal local à l'état RÉEL de ResaMania.
    // Une résa dont le créneau est redevenu libre — ou est désormais pris par quelqu'un
    // d'autre — a été annulée ailleurs : on la marque "cancelled" (fini les fantômes).
    // On reste prudent : si le créneau est absent du planning ou pris par un booker
    // inconnu, on ne juge pas.
    const slotById = new Map(planning.slots.map((s) => [s.id, s]));
    const stale: string[] = [];
    const active = bookings.filter((b) => {
      const slot = slotById.get(b.classEventId);
      if (!slot) return true; // hors planning courant
      if (slot.bookable) {
        stale.push(b.id); // redevenu libre → annulé
        return false;
      }
      if (slot.bookerContactId && slot.bookerContactId !== b.user.contactId) {
        stale.push(b.id); // pris par quelqu'un d'autre → notre résa a sauté
        return false;
      }
      return true; // pris par nous (ou booker inconnu) → on garde
    });
    if (stale.length) {
      await prisma.booking.updateMany({
        where: { id: { in: stale } },
        data: { status: "cancelled" },
      });
    }
    const byEvent = new Map(active.map((b) => [b.classEventId, b.user.displayName]));
    const myContactId = session.resa.identity.contactId;
    const first = (n?: string | null) => (n ?? "").trim().split(/\s+/)[0];

    for (const s of planning.slots) {
      // ResaMania fait foi : un créneau libre reste libre et cliquable, quoi qu'en dise le journal.
      if (s.bookable) continue;
      if (s.bookerContactId && s.bookerContactId === myContactId) {
        s.mine = true;
        s.bookedBy = first(session.resa.identity.givenName) || "Toi";
      } else if (s.bookerContactId && byContact.has(s.bookerContactId)) {
        s.bookedBy = first(byContact.get(s.bookerContactId));
      } else {
        const who = byEvent.get(s.id);
        if (who) s.bookedBy = first(who);
      }
    }

    return NextResponse.json(planning);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
