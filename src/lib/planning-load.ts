import { prisma } from "./db";
import { getPlanning } from "./resamania/client";
import { annotatePlanning } from "./planning-annotate";
import type { PlanningDay } from "./resamania/types";
import type { AppSession } from "./session";

// Partagé entre GET /api/planning et le préchargement SSR de la page (évite un aller-retour
// HTTP interne pour la même donnée).
export async function loadPlanningForSession(
  session: AppSession,
  date: string,
): Promise<PlanningDay> {
  // --- Compte « email seul » (sans jeton ResaMania) : on sert le dernier snapshot du
  //     planning, ré-annoté en direct (présences à jour, dont son propre « +1 »). ---
  if (!session.resa) {
    const snap = await prisma.planningSnapshot.findUnique({ where: { date } });
    if (!snap) {
      return {
        date,
        clubId: "",
        courts: [],
        slots: [],
        cached: true,
        cachedAt: null,
        notice: "Planning pas encore chargé par un membre connecté à ResaMania.",
      };
    }
    const planning = JSON.parse(snap.payloadJson) as PlanningDay;
    await annotatePlanning(planning, session.userId);
    planning.cached = true;
    planning.cachedAt = snap.updatedAt.toISOString();
    return planning;
  }

  // --- Chemin ResaMania (avec jeton) : fetch live → réconciliation → snapshot → annotation. ---
  const resa = session.resa;
  const planning = await getPlanning(date, resa.accessToken);

  // Réconciliation base ↔ ResaMania (nécessite l'état LIVE) : une résa dont le créneau
  // est redevenu libre — ou pris par quelqu'un d'autre — a été annulée ailleurs → on la
  // marque "cancelled". Prudence : créneau hors planning ou booker inconnu → on ne juge pas.
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
  const slotById = new Map(planning.slots.map((s) => [s.id, s]));
  const stale: string[] = [];
  for (const b of bookings) {
    const slot = slotById.get(b.classEventId);
    if (!slot) continue; // hors planning courant
    if (slot.bookable) stale.push(b.id); // redevenu libre → annulé
    else if (slot.bookerContactId && slot.bookerContactId !== b.user.contactId) {
      stale.push(b.id); // pris par quelqu'un d'autre → notre résa a sauté
    }
  }
  if (stale.length) {
    await prisma.booking.updateMany({
      where: { id: { in: stale } },
      data: { status: "cancelled" },
    });
  }
  // Présences orphelines (créneau redevenu libre = résa annulée ailleurs) → purge.
  const freeIds = planning.slots.filter((s) => s.bookable).map((s) => s.id);
  if (freeIds.length) {
    await prisma.attendance.deleteMany({ where: { classEventId: { in: freeIds } } });
  }

  // Snapshot BRUT (avant annotation) → sert les comptes « email seul » sans jeton.
  // Écriture CONDITIONNELLE : on ne réécrit que si le planning a changé (une lecture,
  // moins chère qu'une écriture, évite d'écrire le même gros JSON à chaque affichage —
  // encore plus efficace avec le cache planning, qui renvoie un payload identique).
  const payloadJson = JSON.stringify(planning);
  const prevSnap = await prisma.planningSnapshot.findUnique({
    where: { date },
    select: { payloadJson: true },
  });
  if (!prevSnap || prevSnap.payloadJson !== payloadJson) {
    await prisma.planningSnapshot.upsert({
      where: { date },
      update: { payloadJson, updatedById: session.userId },
      create: { date, payloadJson, updatedById: session.userId },
    });
  }

  // Annotation (qui a réservé + présences) — partagée avec le chemin cache.
  await annotatePlanning(planning, session.userId);

  return planning;
}
