import { NextRequest, NextResponse } from "next/server";
import { book } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isClassEventId } from "@/lib/validation";

export const runtime = "nodejs";

// POST /api/book { classEventId, courtName, startsAt, endsAt }
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { classEventId, courtName, startsAt, endsAt } = await req
    .json()
    .catch(() => ({}));
  if (!isClassEventId(classEventId)) {
    return NextResponse.json({ error: "classEventId invalide" }, { status: 400 });
  }

  // Blocage « même créneau » : ResaMania interdit de réserver 2 terrains au même horaire.
  // 1) Court-circuit local si on connaît déjà une résa à cet horaire → évite un appel
  //    voué à échouer et affiche tout de suite une notif d'information.
  if (startsAt) {
    const clash = await prisma.booking.findFirst({
      where: {
        userId: session.userId,
        status: "booked",
        startsAt: new Date(startsAt),
        NOT: { classEventId },
      },
    });
    if (clash) {
      return NextResponse.json(
        {
          error: `Tu as déjà une réservation sur ce créneau (${clash.courtName}). Un seul terrain par horaire.`,
          code: "overlap",
        },
        { status: 409 },
      );
    }
  }

  const r = await book(session.resa, classEventId);
  if (!r.ok) {
    // 2) Filet de sécurité : ResaMania bloque aussi (has-overlapping-slots) si la résa
    //    en conflit n'était pas connue en base (faite ailleurs).
    if (r.error?.includes("has-overlapping-slots")) {
      return NextResponse.json(
        {
          error: "Tu as déjà une réservation sur ce créneau (autre terrain). Un seul terrain par horaire.",
          code: "overlap",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: r.error }, { status: 409 });
  }

  // Upsert sur la clé unique (userId, classEventId) : réserver un créneau déjà présent
  // dans le journal (ex. annulé puis re-réservé) repasse la même ligne en "booked" au
  // lieu de créer un doublon. La contrainte @@unique garantit l'unicité côté base.
  await prisma.booking.upsert({
    where: {
      userId_classEventId: { userId: session.userId, classEventId },
    },
    update: {
      attendeeId: r.attendeeId ?? null,
      courtName: courtName ?? "?",
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      status: "booked",
    },
    create: {
      userId: session.userId,
      attendeeId: r.attendeeId ?? null,
      classEventId,
      courtName: courtName ?? "?",
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      status: "booked",
    },
  });
  return NextResponse.json({ ok: true, state: r.state });
}
