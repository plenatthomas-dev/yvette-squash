import { NextRequest, NextResponse } from "next/server";
import { getPlanning } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { weekDates } from "@/lib/week";
import type { PlanningDay } from "@/lib/resamania/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/week?date=YYYY-MM-DD  -> planning brut des 7 jours (lundi → dimanche).
//
// Endpoint dédié à la vue Semaine. Contrairement à /api/planning (vue Jour), il NE fait
// PAS la réconciliation base ↔ ResaMania ni l'annotation « qui a réservé / présences » :
// la grille Semaine n'affiche que le NOMBRE de terrains libres (champ `bookable`, qui
// vient directement de ResaMania). On évite ainsi de multiplier par 7 les requêtes DB
// (findMany users/bookings/attendances + updateMany) que faisait l'ancien loadWeek en
// tirant 7× /api/planning en parallèle. La session n'est résolue qu'une seule fois.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date =
    new URL(req.url).searchParams.get("date") ??
    new Date().toISOString().slice(0, 10);

  // Compte « email seul » (sans jeton) : agrégat des snapshots par jour (comptage des libres).
  if (!session.resa) {
    const dates = weekDates(date);
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
    return NextResponse.json(days);
  }
  const resa = session.resa;

  try {
    const days = await Promise.all(
      weekDates(date).map(async (d) => ({
        date: d,
        planning: await getPlanning(d, resa.accessToken),
      })),
    );
    return NextResponse.json(days);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
