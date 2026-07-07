import { NextRequest, NextResponse } from "next/server";
import { getPlanning } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { baseHandle, buildHandleMap } from "@/lib/handle";
import { loadAnnotationUsers } from "@/lib/planning-annotate";
import { weekDates } from "@/lib/week";
import type { PlanningDay } from "@/lib/resamania/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/week?date=YYYY-MM-DD  -> planning des 7 jours (lundi → dimanche), ANNOTÉ.
//
// La vue Semaine affiche, comme la vue Jour, « qui a réservé » (membre de l'asso vs autre)
// et les « +1 » : on annote donc chaque créneau (mine / bookedBy / attendees). Pour rester
// léger malgré les 7 jours, l'annotation est faite EN UNE PASSE (2 requêtes DB pour toute
// la semaine, aucune écriture), pas 7× le travail de /api/planning.
//
// Deux chemins :
//  - ResaMania (avec jeton) : fetch live des 7 jours → snapshots BRUTS (pour les comptes
//    « email seul ») → annotation.
//  - « email seul » (sans jeton) : agrégat des snapshots par jour → annotation.

// Annotation batchée « qui a réservé + présences » sur toute la semaine (lecture seule ;
// ResaMania fait foi : un créneau libre reste libre). Mute days[].planning.slots.
async function annotateWeek(
  days: { date: string; planning: PlanningDay }[],
  userId: string,
): Promise<void> {
  const allSlotIds = days.flatMap((d) => d.planning.slots.map((s) => s.id));
  if (allSlotIds.length === 0) return;

  // Membres (cache mémoire partagé) + bookings + présences en UNE passe parallèle.
  const [users, bookings, attendances] = await Promise.all([
    loadAnnotationUsers(),
    prisma.booking.findMany({
      where: { status: "booked", classEventId: { in: allSlotIds } },
      select: { classEventId: true, userId: true },
    }),
    prisma.attendance.findMany({
      where: { classEventId: { in: allSlotIds } },
      include: { user: true },
    }),
  ]);
  const handleMap = buildHandleMap(users);
  // Certains comptes « email seul » n'ont pas encore de contactId (null) : on les ignore.
  const userIdByContact = new Map<string, string>();
  for (const u of users) if (u.contactId) userIdByContact.set(u.contactId, u.id);
  const myContactId = users.find((u) => u.id === userId)?.contactId ?? null;
  const bookerUserIdByEvent = new Map(bookings.map((b) => [b.classEventId, b.userId]));
  const attByEvent = new Map<string, { userId: string; name: string }[]>();
  for (const a of attendances) {
    const list = attByEvent.get(a.classEventId) ?? [];
    list.push({ userId: a.userId, name: a.user.displayName });
    attByEvent.set(a.classEventId, list);
  }

  for (const d of days) {
    for (const s of d.planning.slots) {
      if (s.bookable) continue; // libre → reste libre, on n'annote pas
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
      if (s.bookedBy) {
        const list = attByEvent.get(s.id) ?? [];
        s.attendees = list
          .filter((a) => a.userId !== bookerUserId)
          .map((a) => handleMap.get(a.userId) ?? baseHandle(a.name));
        s.iAmAttending = list.some((a) => a.userId === userId);
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date =
    new URL(req.url).searchParams.get("date") ??
    new Date().toISOString().slice(0, 10);
  const dates = weekDates(date);

  // --- Compte « email seul » (sans jeton) : agrégat des snapshots par jour, puis annotation. ---
  if (!session.resa) {
    const snaps = await prisma.planningSnapshot.findMany({ where: { date: { in: dates } } });
    const byDate = new Map(snaps.map((s) => [s.date, s]));
    const days = dates.map((d) => {
      const snap = byDate.get(d);
      const planning: PlanningDay = snap
        ? {
            ...(JSON.parse(snap.payloadJson) as PlanningDay),
            cached: true,
            cachedAt: snap.updatedAt.toISOString(),
          }
        : { date: d, clubId: "", courts: [], slots: [], cached: true, cachedAt: null };
      return { date: d, planning };
    });
    await annotateWeek(days, session.userId);
    return NextResponse.json(days);
  }

  // --- Chemin ResaMania (avec jeton) : fetch live → snapshots bruts → annotation. ---
  const resa = session.resa;
  try {
    const days = await Promise.all(
      dates.map(async (d) => ({
        date: d,
        planning: await getPlanning(d, resa.accessToken),
      })),
    );

    // Snapshot BRUT (avant annotation) de chaque jour → alimente le cache des comptes
    // « email seul » : ils verront TOUTE la semaine consultée ici, pas seulement les jours
    // ouverts en vue Jour. Écriture CONDITIONNELLE : une seule lecture batchée des 7 jours,
    // puis on n'upsert QUE les jours dont le planning a changé (souvent aucun → 0 écriture).
    const prevSnaps = await prisma.planningSnapshot.findMany({
      where: { date: { in: dates } },
      select: { date: true, payloadJson: true },
    });
    const prevByDate = new Map(prevSnaps.map((s) => [s.date, s.payloadJson]));
    await Promise.all(
      days
        .map((day) => ({ day, payloadJson: JSON.stringify(day.planning) }))
        .filter(({ day, payloadJson }) => prevByDate.get(day.date) !== payloadJson)
        .map(({ day, payloadJson }) =>
          prisma.planningSnapshot.upsert({
            where: { date: day.date },
            update: { payloadJson, updatedById: session.userId },
            create: { date: day.date, payloadJson, updatedById: session.userId },
          }),
        ),
    );

    await annotateWeek(days, session.userId);

    return NextResponse.json(days);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
