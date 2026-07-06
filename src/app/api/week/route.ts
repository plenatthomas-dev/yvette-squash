import { NextRequest, NextResponse } from "next/server";
import { getPlanning } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { baseHandle, buildHandleMap } from "@/lib/handle";
import { weekDates } from "@/lib/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/week?date=YYYY-MM-DD  -> planning des 7 jours (lundi → dimanche), ANNOTÉ.
//
// La vue Semaine affiche désormais, comme la vue Jour, « qui a réservé » (membre de l'asso
// vs autre) et les « +1 ». On annote donc chaque créneau avec mine / bookedBy / attendees.
// Pour rester léger malgré les 7 jours, on ne fait PAS 7× le travail de /api/planning :
// on résout la session une fois, puis on charge en une seule passe les membres et les
// présences de toute la semaine (2 requêtes DB au total, aucune écriture). Les réservations
// « journal local » servent seulement de repli quand ResaMania n'expose pas le réservataire.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date =
    new URL(req.url).searchParams.get("date") ??
    new Date().toISOString().slice(0, 10);

  try {
    const dates = weekDates(date);
    const days = await Promise.all(
      dates.map(async (d) => ({
        date: d,
        planning: await getPlanning(d, session.resa.accessToken),
      })),
    );

    // --- Données d'annotation, chargées UNE fois pour toute la semaine ---------
    const users = await prisma.user.findMany({
      select: { id: true, contactId: true, displayName: true, nickname: true, createdAt: true },
    });
    const handleMap = buildHandleMap(users);
    const userIdByContact = new Map(users.map((u) => [u.contactId, u.id]));
    const myContactId = session.resa.identity.contactId;

    // Tous les créneaux de la semaine (IRIs) → repli journal + présences en une requête.
    const allSlotIds = days.flatMap((d) => d.planning.slots.map((s) => s.id));
    const [bookings, attendances] = await Promise.all([
      prisma.booking.findMany({
        where: { status: "booked", classEventId: { in: allSlotIds } },
        select: { classEventId: true, userId: true },
      }),
      prisma.attendance.findMany({
        where: { classEventId: { in: allSlotIds } },
        include: { user: true },
      }),
    ]);
    const bookerUserIdByEvent = new Map(bookings.map((b) => [b.classEventId, b.userId]));
    const attByEvent = new Map<string, { userId: string; name: string }[]>();
    for (const a of attendances) {
      const list = attByEvent.get(a.classEventId) ?? [];
      list.push({ userId: a.userId, name: a.user.displayName });
      attByEvent.set(a.classEventId, list);
    }

    // --- Annotation créneau par créneau (lecture seule, ResaMania fait foi) -----
    for (const d of days) {
      for (const s of d.planning.slots) {
        if (s.bookable) continue; // libre → reste libre, on n'annote pas
        let bookerUserId: string | null = null;
        if (s.bookerContactId && s.bookerContactId === myContactId) {
          s.mine = true;
          bookerUserId = session.userId;
        } else if (s.bookerContactId && userIdByContact.has(s.bookerContactId)) {
          bookerUserId = userIdByContact.get(s.bookerContactId) ?? null;
        } else if (bookerUserIdByEvent.has(s.id)) {
          bookerUserId = bookerUserIdByEvent.get(s.id) ?? null;
        }
        if (bookerUserId) {
          s.bookedBy = handleMap.get(bookerUserId) ?? (s.mine ? "Toi" : null);
        }
        if (s.bookedBy) {
          const list = attByEvent.get(s.id) ?? [];
          s.attendees = list
            .filter((a) => a.userId !== bookerUserId)
            .map((a) => handleMap.get(a.userId) ?? baseHandle(a.name));
          s.iAmAttending = list.some((a) => a.userId === session.userId);
        }
      }
    }

    return NextResponse.json(days);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
