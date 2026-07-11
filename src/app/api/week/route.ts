import { NextRequest, NextResponse } from "next/server";
import { getPlanning, getStudios } from "@/lib/resamania/client";
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

  // Ne JAMAIS renvoyer au client le contactId ResaMania brut du réservataire (identifiant
  // interne d'un tiers) : il n'a servi qu'à la résolution d'identité. Les snapshots sont
  // écrits AVANT cet appel (ils le conservent pour le chemin « email seul ») ; ici on le
  // retire seulement des objets renvoyés. Cf. annotatePlanning (même règle, vue Jour).
  for (const d of days) for (const s of d.planning.slots) delete s.bookerContactId;
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
  // Tolérant aux pannes : un jour dont le fetch ResaMania échoue ou traîne (timeout ~8 s,
  // cf. RESA_FETCH_TIMEOUT_MS) retombe sur son snapshot au lieu de bloquer toute la semaine.
  // On utilise Promise.allSettled (pas Promise.all) : sinon UN seul jour coincé gelait tout
  // /api/week ~60 s → login figé quand l'URL ouvre directement la vue Semaine.
  const resa = session.resa;
  try {
    // Snapshots existants : servent de repli (jour en échec) ET de base au diff d'upsert.
    const prevSnaps = await prisma.planningSnapshot.findMany({
      where: { date: { in: dates } },
      select: { date: true, payloadJson: true, updatedAt: true },
    });
    const prevByDate = new Map(prevSnaps.map((s) => [s.date, s]));

    // Studios chargés UNE fois, partagés par les 7 jours (au lieu de 7 appels /studios
    // concurrents → moitié moins de connexions simultanées vers ResaMania). Best-effort :
    // un échec ⇒ map vide (noms de terrains = ID bruts), on ne bloque pas la semaine.
    const studios = await getStudios(resa.accessToken).catch(
      () => new Map<string, string>(),
    );

    const settled = await Promise.allSettled(
      dates.map((d) => getPlanning(d, resa.accessToken, studios)),
    );

    // Jours réellement récupérés (à re-snapshotter) ; les échecs retombent sur le snapshot.
    const fetched = new Map<string, PlanningDay>();
    const days = dates.map((d, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        fetched.set(d, r.value);
        return { date: d, planning: r.value };
      }
      const snap = prevByDate.get(d);
      const planning: PlanningDay = snap
        ? {
            ...(JSON.parse(snap.payloadJson) as PlanningDay),
            cached: true,
            cachedAt: snap.updatedAt.toISOString(),
          }
        : { date: d, clubId: "", courts: [], slots: [], cached: true, cachedAt: null };
      return { date: d, planning };
    });

    // Snapshot BRUT (avant annotation) → alimente le cache des comptes « email seul ».
    // On n'upsert QUE les jours réellement récupérés ET modifiés (jamais écraser un bon
    // snapshot par un jour en échec ; souvent aucun changement → 0 écriture).
    await Promise.all(
      [...fetched.entries()]
        .map(([d, planning]) => ({ d, payloadJson: JSON.stringify(planning) }))
        .filter(({ d, payloadJson }) => prevByDate.get(d)?.payloadJson !== payloadJson)
        .map(({ d, payloadJson }) =>
          prisma.planningSnapshot.upsert({
            where: { date: d },
            update: { payloadJson, updatedById: session.userId },
            create: { date: d, payloadJson, updatedById: session.userId },
          }),
        ),
    );

    await annotateWeek(days, session.userId);

    return NextResponse.json(days);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
