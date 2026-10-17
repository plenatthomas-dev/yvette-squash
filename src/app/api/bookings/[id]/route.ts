import { NextRequest, NextResponse } from "next/server";
import { cancel, findAttendeeId, invalidatePlanningCache } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { resolveActingContext } from "@/lib/delegation";
import { refreshSnapshotFromResa } from "@/lib/planning-snapshot";
import { appBlockForUserId, appBlockedResponse } from "@/lib/app-block";
import { isResaOutcomeUnknown, isResaUnavailable } from "@/lib/resamania/errors";
import { outcomeUnknownResponse, resaUnavailableResponse } from "@/lib/resamania/responses";

export const runtime = "nodejs";

// DELETE /api/bookings/{id} { onBehalfOf? } -> annule la réservation (ResaMania + journal).
// onBehalfOf (idée 4) : userId du délégant si on annule en son nom (délégation active).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // Appli fermée par un admin : plus d'annulation côté membres (les admins passent).
  const block = await appBlockForUserId(session.userId);
  if (block) return appBlockedResponse(block);

  const { onBehalfOf } = (await req.json().catch(() => ({}))) as { onBehalfOf?: unknown };

  const acting = await resolveActingContext(
    session,
    onBehalfOf,
    "L'annulation d'une réservation nécessite une connexion ResaMania.",
  );
  if (!acting.ok) {
    // `code` relayé quand il existe (« resa-unavailable » : 503 de panne ResaMania).
    return NextResponse.json(
      { error: acting.error, ...(acting.code ? { code: acting.code } : {}) },
      { status: acting.status },
    );
  }
  const { resa, bookingOwnerId, actingUserId } = acting.ctx;

  const { id } = await params;
  const booking = await prisma.booking.findUnique({ where: { id } });
  if (!booking || booking.userId !== bookingOwnerId) {
    return NextResponse.json({ error: "Réservation introuvable" }, { status: 404 });
  }

  // Rattrapage : si l'attendeeId n'a pas été mémorisé, on le retrouve via l'API.
  let attendeeId = booking.attendeeId;
  if (!attendeeId) {
    try {
      attendeeId = await findAttendeeId(resa, booking.classEventId);
    } catch (e) {
      // ResaMania injoignable : ce n'est PAS « référence introuvable » (qui invite à annuler
      // directement sur ResaMania). Lecture seule, rien n'a bougé : réessayer est sans danger.
      if (isResaUnavailable(e)) return resaUnavailableResponse();
      throw e;
    }
    if (attendeeId) {
      await prisma.booking.update({ where: { id }, data: { attendeeId } });
    }
  }
  if (!attendeeId) {
    return NextResponse.json(
      { error: "Référence ResaMania introuvable — annule directement sur ResaMania." },
      { status: 422 },
    );
  }

  let r;
  try {
    r = await cancel(resa, attendeeId);
  } catch (e) {
    // Annulation partie sans réponse : elle a PEUT-ÊTRE abouti. Ni « réessaie » (on retenterait
    // une transition peut-être déjà faite — refusée, au mieux, avec un message incompréhensible)
    // ni « annulée » (peut-être faux). Le journal reste « booked » : la réconciliation du
    // planning le passera « cancelled » si le créneau s'est bien libéré. Cache vidé pour que
    // la grille que le membre va consulter soit celle de ResaMania.
    if (isResaOutcomeUnknown(e)) {
      console.warn("[bookings] annulation partie sans réponse, résultat inconnu:", e);
      invalidatePlanningCache();
      return outcomeUnknownResponse("L'annulation");
    }
    throw e;
  }
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 409 });
  }
  await prisma.booking.update({ where: { id }, data: { status: "cancelled", actingUserId } });
  // Le créneau se libère : purge le cache planning.
  invalidatePlanningCache();

  // Annulation AU NOM d'un délégant : rafraîchit le snapshot pour que le délégataire « email
  // seul » voie le créneau redevenir libre tout de suite (cf. /api/book pour le détail).
  if (actingUserId) {
    await refreshSnapshotFromResa(booking.startsAt.toISOString().slice(0, 10), resa, bookingOwnerId);
  }
  return NextResponse.json({ ok: true });
}
