import { prisma } from "./db";
import { loadAnnotationUsers } from "./planning-annotate";
import { getFeatures } from "./features-server";
import type { PlanningDay } from "./resamania/types";

// Réconciliation base ↔ ResaMania pour UNE journée (nécessite l'état LIVE du planning,
// donc appelée uniquement sur le chemin avec jeton — cf. api/planning). Deux directions :
//
//  1. Une résa connue de l'appli ("app" ou "resamania") dont le créneau est redevenu libre
//     — ou pris par quelqu'un d'autre — a été annulée ailleurs → on la marque "cancelled".
//     Inconditionnel, comme avant l'extraction de ce module.
//
//  2. (derrière le flag `externalBookings`) Un créneau réservé par un membre CONNU
//     (bookerContactId résolu) sans AUCUNE ligne Booking active pour ce classEventId a été
//     réservé directement sur ResaMania (hors appli) → on crée la ligne, `source: "resamania"`.
//     C'est ce qui permet de répondre à « ce membre a-t-il réservé via l'appli ou sur
//     ResaMania ? » : toute ligne Booking sans ambiguïté porte désormais sa source.
//
// Prudence commune aux deux sens : créneau hors planning courant ou booker inconnu → on ne
// juge pas (on laisse l'état tel quel plutôt que de risquer un faux verdict).
//
// FRAÎCHEUR DE LA PHOTO. Le sens 1 est une écriture DESTRUCTIVE fondée sur une photo du
// planning : une résa faite APRÈS la photo y apparaît forcément « libre ». Si la photo date de
// 15 s (cache mémoire d'une instance) et qu'un membre vient de réserver via une AUTRE instance,
// on annulerait dans le journal une résa bien réelle — et elle disparaîtrait de « Mes résas ».
// D'où deux gardes : l'appelant ne réconcilie que sur une photo lue À L'INSTANT (cf.
// api/planning, `fromCache`), et ici on ne JUGE PAS une ligne créée moins de
// `PHOTO_MARGIN_MS` avant la photo (`fetchedAt`) ou après — la marge couvre le délai entre
// l'écriture côté ResaMania et sa visibilité dans leur planning.
// Limite connue : une RE-réservation repasse une ligne existante en "booked" sans toucher
// `createdAt` (upsert de api/book) ; elle n'est couverte que par la première garde.
const PHOTO_MARGIN_MS = 5_000;

export async function reconcilePlanningWithBookings(
  planning: PlanningDay,
  date: string,
  // Instant (epoch ms) de la photo du planning (cf. `getPlanningWithMeta`). Omis : aucune
  // ligne n'est épargnée (comportement d'origine — réservé aux appelants qui savent que la
  // photo est postérieure à toute écriture).
  fetchedAt?: number,
): Promise<void> {
  const judgedBefore = fetchedAt === undefined ? null : new Date(fetchedAt - PHOTO_MARGIN_MS);
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
  const activeEventIds = new Set<string>();
  // Créneaux dont une résa est trop récente pour la photo : ni annulée, ni purgée de ses
  // présences, ni candidate à la détection « hors appli » (elle vient de l'appli).
  const tooRecentIds = new Set<string>();
  for (const b of bookings) {
    const slot = slotById.get(b.classEventId);
    if (!slot) continue; // hors planning courant
    if (judgedBefore && b.createdAt > judgedBefore) {
      tooRecentIds.add(b.classEventId);
      activeEventIds.add(b.classEventId);
      continue;
    }
    if (slot.bookable) stale.push(b.id); // redevenu libre → annulé
    else if (slot.bookerContactId && slot.bookerContactId !== b.user.contactId) {
      stale.push(b.id); // pris par quelqu'un d'autre → notre résa a sauté
    } else {
      activeEventIds.add(b.classEventId);
    }
  }
  if (stale.length) {
    await prisma.booking.updateMany({
      where: { id: { in: stale } },
      data: { status: "cancelled" },
    });
  }

  // Présences orphelines (créneau redevenu libre = résa annulée ailleurs) → purge.
  const freeIds = planning.slots
    .filter((s) => s.bookable && !tooRecentIds.has(s.id))
    .map((s) => s.id);
  if (freeIds.length) {
    await prisma.attendance.deleteMany({ where: { classEventId: { in: freeIds } } });
  }

  // Créneaux pris dont le journal ne rend PAS compte : seuls candidats à une détection.
  // Ce tri est purement en mémoire (aucune requête) et il est fait AVANT de consulter le
  // flag, à dessein : sur une journée dont toutes les résas sont déjà connues — le cas
  // courant — la réconciliation se termine ici sans une seule requête de plus qu'avant
  // cette fonction. Inutile de demander à la base si une option est active quand on n'a
  // rien à écrire, d'autant que la base Neon dort dès qu'on la laisse tranquille.
  const candidates = planning.slots.filter(
    (s) => !s.bookable && s.bookerContactId && !activeEventIds.has(s.id),
  );
  if (candidates.length === 0) return;

  if (!(await getFeatures()).externalBookings) return;

  // Liste des membres : cache mémoire de 60 s, et `annotatePlanning` la relira dans la même
  // requête → en pratique aucune lecture supplémentaire, juste avancée dans le temps.
  const users = await loadAnnotationUsers();
  const userIdByContact = new Map(
    users.filter((u) => u.contactId).map((u) => [u.contactId as string, u.id]),
  );
  for (const s of candidates) {
    const bookerUserId = userIdByContact.get(s.bookerContactId as string);
    if (!bookerUserId) continue; // pas un membre connu (ou non lié) → hors périmètre du journal

    await prisma.booking.upsert({
      where: { userId_classEventId: { userId: bookerUserId, classEventId: s.id } },
      // Rebooking direct sur ResaMania après une annulation faite depuis l'appli : on repasse
      // la ligne existante en "booked", source "resamania" (c'est ResaMania qui fait foi ici).
      update: { status: "booked", source: "resamania", attendeeId: null, actingUserId: null, startsAt: s.startsAt, endsAt: s.endsAt, courtName: s.courtName },
      create: {
        userId: bookerUserId,
        classEventId: s.id,
        courtName: s.courtName,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: "booked",
        source: "resamania",
      },
    });
  }
}
