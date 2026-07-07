import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/alerts/counts?from=YYYY-MM-DD&to=YYYY-MM-DD
// Nombre de membres EN ATTENTE (liste d'attente, idée D) par créneau, pour la plage
// affichée (jour = from==to, semaine = 7 jours). Renvoie { "YYYY-MM-DD|HH:MM": n }.
// N'expose QUE des compteurs — jamais l'identité des inscrits (RGPD).
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (
    !from ||
    !to ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to)
  ) {
    return NextResponse.json({ error: "Plage invalide" }, { status: 400 });
  }
  // `date` est une chaîne "YYYY-MM-DD" : la comparaison lexicographique = chronologique.
  const rows = await prisma.slotAlert.groupBy({
    by: ["date", "hm"],
    where: { active: true, date: { gte: from, lte: to } },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[`${r.date}|${r.hm}`] = r._count._all;
  return NextResponse.json(counts);
}
