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
      select: { id: true, contactId: true, displayName: true },
    });
    const byContact = new Map(users.map((u) => [u.contactId, u.displayName]));
    const userIdByContact = new Map(users.map((u) => [u.contactId, u.id]));

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
    const bookerUserIdByEvent = new Map(active.map((b) => [b.classEventId, b.userId]));
    const myContactId = session.resa.identity.contactId;
    const first = (n?: string | null) => (n ?? "").trim().split(/\s+/)[0];

    // Présences « asso » (signal local) des créneaux du jour. On purge les orphelines
    // (créneau redevenu libre = résa annulée ailleurs) puis on regroupe le reste par créneau.
    const slotIds = planning.slots.map((s) => s.id);
    const freeIds = new Set(planning.slots.filter((s) => s.bookable).map((s) => s.id));
    const attendances = await prisma.attendance.findMany({
      where: { classEventId: { in: slotIds } },
      include: { user: true },
    });
    const orphanIds = attendances.filter((a) => freeIds.has(a.classEventId)).map((a) => a.id);
    if (orphanIds.length) {
      await prisma.attendance.deleteMany({ where: { id: { in: orphanIds } } });
    }
    const attByEvent = new Map<string, { userId: string; name: string }[]>();
    for (const a of attendances) {
      if (freeIds.has(a.classEventId)) continue; // orphelin (supprimé ci-dessus)
      const list = attByEvent.get(a.classEventId) ?? [];
      list.push({ userId: a.userId, name: a.user.displayName });
      attByEvent.set(a.classEventId, list);
    }

    for (const s of planning.slots) {
      // ResaMania fait foi : un créneau libre reste libre et cliquable, quoi qu'en dise le journal.
      if (s.bookable) continue;
      let bookerUserId: string | null = null;
      if (s.bookerContactId && s.bookerContactId === myContactId) {
        s.mine = true;
        s.bookedBy = first(session.resa.identity.givenName) || "Toi";
        bookerUserId = session.userId;
      } else if (s.bookerContactId && byContact.has(s.bookerContactId)) {
        s.bookedBy = first(byContact.get(s.bookerContactId));
        bookerUserId = userIdByContact.get(s.bookerContactId) ?? null;
      } else {
        const who = byEvent.get(s.id);
        if (who) {
          s.bookedBy = first(who);
          bookerUserId = bookerUserIdByEvent.get(s.id) ?? null;
        }
      }
      // Présences : seulement sur les créneaux « asso » (réservataire connu), réservataire exclu.
      if (s.bookedBy) {
        const list = attByEvent.get(s.id) ?? [];
        s.attendees = list.filter((a) => a.userId !== bookerUserId).map((a) => first(a.name));
        s.iAmAttending = list.some((a) => a.userId === session.userId);
      }
    }

    return NextResponse.json(planning);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
