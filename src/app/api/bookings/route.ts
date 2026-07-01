import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/bookings[?date=YYYY-MM-DD]  -> journal partagé (qui a réservé quoi)
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date = new URL(req.url).searchParams.get("date");
  const where = date
    ? {
        startsAt: {
          gte: new Date(`${date}T00:00:00`),
          lte: new Date(`${date}T23:59:59`),
        },
      }
    : { startsAt: { gte: new Date(Date.now() - 3600_000) } }; // à venir

  const bookings = await prisma.booking.findMany({
    where: { status: "booked", ...where },
    include: { user: true },
    orderBy: { startsAt: "asc" },
    take: 100,
  });

  return NextResponse.json(
    bookings.map((b) => ({
      id: b.id,
      displayName: b.user.displayName,
      courtName: b.courtName,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      mine: b.userId === session.userId,
    })),
  );
}
