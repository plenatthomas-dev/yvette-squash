import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { login, getPlanning } from "@/lib/resamania/client";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAYS_AHEAD = 14; // on préchauffe hier → aujourd'hui + 14 jours

// Jeton ResaMania d'un compte « de service » DÉDIÉ (identifiants en variables d'env) :
// le cron se connecte lui-même à chaque passage → indépendant des sessions des membres,
// aucune interférence avec elles, et une couverture garantie du cache.
async function serviceToken(): Promise<string | null> {
  const username = process.env.RESA_CRON_USER;
  const password = process.env.RESA_CRON_PASSWORD;
  if (!username || !password) return null;
  try {
    const resa = await login({ username, password });
    return resa.accessToken;
  } catch {
    return null;
  }
}

function dayISO(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// GET /api/cron/warm-planning
// Préchauffe le cache du planning (PlanningSnapshot) pour hier → +14 jours avec le compte
// de service, pour qu'un compte « email seul » voie toujours le planning à venir, sans
// dépendre de qui a navigué. Idempotent (upsert). Séquentiel (doux pour ResaMania).
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }
  const token = await serviceToken();
  if (!token) {
    // Signal de santé ResaMania pour le tableau de bord : le compte de service ne se connecte pas.
    await recordCronRun("warm-planning", false, "compte de service ResaMania KO");
    return NextResponse.json({
      warmed: 0,
      reason: "Compte de service ResaMania non configuré ou connexion échouée.",
    });
  }

  const dates: string[] = [];
  for (let o = -1; o <= DAYS_AHEAD; o++) dates.push(dayISO(o));

  let warmed = 0;
  for (const date of dates) {
    try {
      const planning = await getPlanning(date, token);
      const payloadJson = JSON.stringify(planning);
      await prisma.planningSnapshot.upsert({
        where: { date },
        update: { payloadJson, updatedById: null },
        create: { date, payloadJson, updatedById: null },
      });
      warmed++;
    } catch {
      // Jour indisponible / erreur ponctuelle ResaMania → on continue.
    }
  }
  await recordCronRun("warm-planning", true, `${warmed}/${dates.length} jours`);
  return NextResponse.json({ warmed, total: dates.length });
}
