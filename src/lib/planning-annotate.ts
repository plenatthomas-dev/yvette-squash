import { prisma } from "./db";
import { buildHandleMap, baseHandle } from "./handle";
import type { PlanningDay } from "./resamania/types";

// Liste des membres utilisée pour l'annotation (nom/pseudo/contactId). Relue à CHAQUE
// affichage du planning, mais elle change rarement → cache mémoire court (60 s) partagé.
// Retire une requête DB du chemin chaud (et du « réveil » d'une base Neon endormie).
// Invalidé explicitement sur mise à jour de profil (cf. invalidateAnnotationUsers).
export type AnnotationUser = {
  id: string;
  contactId: string | null;
  displayName: string;
  nickname: string | null;
  createdAt: Date;
};
const USERS_TTL_MS = 60_000;
let usersCache: { at: number; data: AnnotationUser[] } | null = null;

export async function loadAnnotationUsers(): Promise<AnnotationUser[]> {
  if (usersCache && Date.now() - usersCache.at < USERS_TTL_MS) return usersCache.data;
  const data = await prisma.user.findMany({
    select: { id: true, contactId: true, displayName: true, nickname: true, createdAt: true },
  });
  usersCache = { at: Date.now(), data };
  return data;
}

/** Vide le cache de la liste des membres (après changement de pseudo / visibilité). */
export function invalidateAnnotationUsers(): void {
  usersCache = null;
}

/**
 * Annote les slots d'un planning : qui du groupe a réservé (contactId connu ou journal
 * local) + les présences « +1 ». LECTURE SEULE — aucune réconciliation live (celle-ci,
 * qui écrit en base, reste dans le chemin ResaMania). Partagé entre le chemin ResaMania
 * et le chemin « cache » (compte email seul) pour un rendu identique. Mute planning.slots.
 */
export async function annotatePlanning(planning: PlanningDay, userId: string): Promise<void> {
  const slotIds = planning.slots.map((s) => s.id);
  // Les 3 lectures sont indépendantes → en parallèle (1 aller-retour au lieu de 3, ce qui
  // compte double sur une base froide). La liste des membres vient souvent du cache.
  const [users, bookings, attendances] = await Promise.all([
    loadAnnotationUsers(),
    prisma.booking.findMany({
      where: { status: "booked", classEventId: { in: slotIds } },
      select: { classEventId: true, userId: true },
    }),
    prisma.attendance.findMany({
      where: { classEventId: { in: slotIds } },
      include: { user: true },
    }),
  ]);
  const handleMap = buildHandleMap(users);
  const userIdByContact = new Map(
    users.filter((u) => u.contactId).map((u) => [u.contactId as string, u.id]),
  );
  const myContactId = users.find((u) => u.id === userId)?.contactId ?? null;

  const bookerUserIdByEvent = new Map(bookings.map((b) => [b.classEventId, b.userId]));
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
