import { NextRequest, NextResponse } from "next/server";
import { cancel, findAttendeeId, invalidatePlanningCache } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isClassEventId } from "@/lib/validation";
import { resolveActingContext } from "@/lib/delegation";
import { refreshSnapshotFromResa } from "@/lib/planning-snapshot";
import { appBlockForUserId, appBlockedResponse } from "@/lib/app-block";
import { isResaOutcomeUnknown, isResaUnavailable } from "@/lib/resamania/errors";
import { outcomeUnknownResponse, resaUnavailableResponse } from "@/lib/resamania/responses";

export const runtime = "nodejs";

// POST /api/cancel-slot  { classEventId, onBehalfOf? }
// Annule la réservation du joueur courant (ou du délégant, idée 4) pour un créneau, en
// résolvant son attendee en direct (marche aussi si la résa n'a pas été faite via l'appli).
// Sert au clic « annuler depuis la grille ».
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // Appli fermée par un admin : plus d'annulation côté membres (les admins passent).
  const block = await appBlockForUserId(session.userId);
  if (block) return appBlockedResponse(block);

  const { classEventId, onBehalfOf } = (await req.json().catch(() => ({}))) as {
    classEventId?: unknown;
    onBehalfOf?: unknown;
  };

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

  if (!isClassEventId(classEventId)) {
    return NextResponse.json({ error: "classEventId invalide" }, { status: 400 });
  }

  let attendeeId: string | null;
  try {
    attendeeId = await findAttendeeId(resa, classEventId);
  } catch (e) {
    // ResaMania injoignable ≠ « réservation introuvable » : ce 404 faisait croire au membre que
    // sa résa avait disparu. Lecture seule, rien n'a bougé : réessayer est sans danger.
    if (isResaUnavailable(e)) return resaUnavailableResponse();
    throw e;
  }
  if (!attendeeId) {
    return NextResponse.json(
      { error: "Réservation introuvable côté ResaMania." },
      { status: 404 },
    );
  }

  let r;
  try {
    r = await cancel(resa, attendeeId);
  } catch (e) {
    // Annulation partie sans réponse : résultat INCONNU (cf. /api/bookings/[id], même règle).
    // Journal laissé tel quel — la réconciliation du planning tranchera —, cache vidé pour
    // que le membre voie l'état réel en rechargeant.
    if (isResaOutcomeUnknown(e)) {
      console.warn("[cancel-slot] annulation partie sans réponse, résultat inconnu:", e);
      invalidatePlanningCache();
      return outcomeUnknownResponse("L'annulation");
    }
    throw e;
  }
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 409 });
  }

  // Aligne le journal local si une résa correspond. On lit d'abord son startsAt : utile
  // pour rafraîchir le bon snapshot en cas d'annulation par délégation (la date n'est pas
  // dans la requête, juste le classEventId).
  const local = await prisma.booking.findFirst({
    where: { userId: bookingOwnerId, classEventId, status: "booked" },
    select: { startsAt: true },
  });
  await prisma.booking.updateMany({
    where: { userId: bookingOwnerId, classEventId, status: "booked" },
    data: { status: "cancelled", actingUserId },
  });

  // Un terrain vient de se libérer. On ne connaît pas la date ici (juste le classEventId)
  // → on vide tout le cache planning (annulations rares, recharge en une requête).
  invalidatePlanningCache();

  // Annulation AU NOM d'un délégant : rafraîchit le snapshot pour que le délégataire « email
  // seul » voie le créneau redevenir libre tout de suite (cf. /api/book). Sans résa locale
  // connue, on ne sait pas quel jour rafraîchir → on laisse le cycle normal s'en charger.
  if (actingUserId && local) {
    await refreshSnapshotFromResa(local.startsAt.toISOString().slice(0, 10), resa, bookingOwnerId);
  }
  return NextResponse.json({ ok: true });
}
