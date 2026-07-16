import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getActiveIncomingDelegations } from "@/lib/delegation";
import { getFeatures } from "@/lib/features-server";

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

  // Résas d'un délégant que JE peux gérer (annuler) via une délégation active : sans ça, un
  // délégataire — notamment un compte « email seul » — voyait la résa qu'il a faite au nom du
  // délégant mais sans pouvoir l'annuler (le journal ne montre les boutons que sur `mine`).
  // On renvoie l'id du délégant à passer en `onBehalfOf`. L'API d'annulation revérifie la
  // délégation → l'exposition ici ne fait que RÉVÉLER un droit que le délégataire détient déjà.
  const delegationOn = (await getFeatures()).delegation;
  const delegatorIds = delegationOn
    ? new Set((await getActiveIncomingDelegations(session.userId)).map((d) => d.delegatorId))
    : new Set<string>();

  return NextResponse.json(
    bookings.map((b) => {
      const mine = b.userId === session.userId;
      return {
        id: b.id,
        displayName: b.user.displayName,
        courtName: b.courtName,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        mine,
        // id du délégant à passer en onBehalfOf pour annuler, ou null si non gérable via délégation.
        manageableOnBehalfOf: !mine && delegatorIds.has(b.userId) ? b.userId : null,
      };
    }),
  );
}
