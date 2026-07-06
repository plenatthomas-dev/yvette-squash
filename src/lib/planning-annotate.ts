import { prisma } from "./db";
import { buildHandleMap, baseHandle } from "./handle";
import type { PlanningDay } from "./resamania/types";

/**
 * Annote les slots d'un planning : qui du groupe a réservé (contactId connu ou journal
 * local) + les présences « +1 ». LECTURE SEULE — aucune réconciliation live (celle-ci,
 * qui écrit en base, reste dans le chemin ResaMania). Partagé entre le chemin ResaMania
 * et le chemin « cache » (compte email seul) pour un rendu identique. Mute planning.slots.
 */
export async function annotatePlanning(planning: PlanningDay, userId: string): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, contactId: true, displayName: true, nickname: true, createdAt: true },
  });
  const handleMap = buildHandleMap(users);
  const userIdByContact = new Map(
    users.filter((u) => u.contactId).map((u) => [u.contactId as string, u.id]),
  );
  const myContactId = users.find((u) => u.id === userId)?.contactId ?? null;

  const slotIds = planning.slots.map((s) => s.id);
  const bookings = await prisma.booking.findMany({
    where: { status: "booked", classEventId: { in: slotIds } },
    select: { classEventId: true, userId: true },
  });
  const bookerUserIdByEvent = new Map(bookings.map((b) => [b.classEventId, b.userId]));

  const attendances = await prisma.attendance.findMany({
    where: { classEventId: { in: slotIds } },
    include: { user: true },
  });
  const attByEvent = new Map<string, { userId: string; name: string }[]>();
  for (const a of attendances) {
    const list = attByEvent.get(a.classEventId) ?? [];
    list.push({ userId: a.userId, name: a.user.displayName });
    attByEvent.set(a.classEventId, list);
  }

  for (const s of planning.slots) {
    // ResaMania fait foi : un créneau libre reste libre et cliquable.
    if (s.bookable) continue;
    let bookerUserId: string | null = null;
    if (s.bookerContactId && s.bookerContactId === myContactId) {
      s.mine = true;
      bookerUserId = userId;
    } else if (s.bookerContactId && userIdByContact.has(s.bookerContactId)) {
      bookerUserId = userIdByContact.get(s.bookerContactId) ?? null;
    } else if (bookerUserIdByEvent.has(s.id)) {
      bookerUserId = bookerUserIdByEvent.get(s.id) ?? null;
    }
    if (bookerUserId) {
      s.bookedBy = handleMap.get(bookerUserId) ?? (s.mine ? "Toi" : null);
    }
    // Présences : seulement sur les créneaux « asso » (réservataire connu), réservataire exclu.
    if (s.bookedBy) {
      const list = attByEvent.get(s.id) ?? [];
      s.attendees = list
        .filter((a) => a.userId !== bookerUserId)
        .map((a) => handleMap.get(a.userId) ?? baseHandle(a.name));
      s.iAmAttending = list.some((a) => a.userId === userId);
    }
  }
}
