import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPlanning } from "@/lib/resamania/client";
import { serviceToken } from "@/lib/resamania/service";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, runCron } from "@/lib/cron-run";
import { purgeRetention, purgedTotal } from "@/lib/retention-purge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s : la limite des fonctions Vercel (Fluid compute, plan Hobby compris). 60 s coupait les
// passes longues en plein milieu — toujours les mêmes membres, ceux de fin de liste.
export const maxDuration = 300;

const DAYS_AHEAD = 14; // on préchauffe hier → aujourd'hui + 14 jours

// Le cron se connecte lui-même avec le compte « de service » à chaque passage (cf.
// lib/resamania/service) → indépendant des sessions des membres, aucune interférence avec
// elles, et une couverture garantie du cache.

function dayISO(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// GET /api/cron/warm-planning
// Préchauffe le cache du planning (PlanningSnapshot) pour hier → +14 jours avec le compte
// de service, pour qu'un compte « email seul » voie toujours le planning à venir, sans
// dépendre de qui a navigué. Idempotent (upsert). Séquentiel (doux pour ResaMania).

async function handle(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  // Purge AVANT tout le reste, et surtout avant le garde « compte de service » : la rétention
  // est une promesse faite aux gens, elle ne doit pas dépendre de la santé de ResaMania. Si on
  // la mettait en fin de fonction, une panne du compte de service ferait sortir le cron en
  // amont et les snapshots — qui portent le contactId de tiers — s'accumuleraient sans fin.
  // Toutes les durées annoncées passent ici, pas seulement le planning (cf. retention-purge).
  const purged = purgedTotal(await purgeRetention());

  const service = await serviceToken();
  if (!("token" in service)) {
    // Signal de santé ResaMania pour le tableau de bord : le compte de service ne se connecte
    // pas, avec la raison (panne passagère, identifiants refusés, non configuré).
    await recordCronRun("warm-planning", false, service.reason);
    return NextResponse.json({
      warmed: 0,
      purged,
      reason: "Compte de service ResaMania non configuré ou connexion échouée.",
    });
  }

  const dates: string[] = [];
  for (let o = -1; o <= DAYS_AHEAD; o++) dates.push(dayISO(o));

  const { token } = service;
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
  // Vert seulement si le préchauffage a VRAIMENT eu lieu : « 0/16 jours » en vert masquait une
  // panne complète. Deux jours manqués sont tolérés (un hoquet ponctuel de ResaMania).
  await recordCronRun(
    "warm-planning",
    warmed >= dates.length - 2,
    `${warmed}/${dates.length} jours${purged ? `, ${purged} purgé(s)` : ""}`,
  );
  return NextResponse.json({ warmed, total: dates.length, purged });
}

// Filet commun (cf. lib/cron-run) : une exception laisse une trace `ok: false` au lieu du
// « ok » de la veille.
export const GET = (req: NextRequest) => runCron("warm-planning", () => handle(req));
