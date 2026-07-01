import { NextRequest, NextResponse } from "next/server";
import { book } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

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
  if (!classEventId) {
    return NextResponse.json({ error: "classEventId requis" }, { status: 400 });
  }

  const r = await book(session.resa, classEventId);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 409 });
  }

  await prisma.booking.create({
    data: {
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
