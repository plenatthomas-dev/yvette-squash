import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { login, getPlanning } from "@/lib/resamania/client";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { SNAPSHOT_RETENTION_DAYS } from "@/lib/retention";
import { isResaAuthRejected, isResaUnavailable } from "@/lib/resamania/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAYS_AHEAD = 14; // on préchauffe hier → aujourd'hui + 14 jours

// Jeton ResaMania d'un compte « de service » DÉDIÉ (identifiants en variables d'env) :
// le cron se connecte lui-même à chaque passage → indépendant des sessions des membres,
// aucune interférence avec elles, et une couverture garantie du cache.
//
// Ce cron n'utilise NI `getSession` NI `getResaTokenForUser` : il n'est donc pas touché par
// `ResaRefreshTransientError`. Son `login()` est déjà sous try/catch (aucune exception ne sort
// d'ici) ; ce qui change avec les erreurs typées de client.ts, c'est qu'on peut enfin DIRE au
// tableau de bord pourquoi le préchauffage n'a pas eu lieu — « ResaMania en panne, ça
// reviendra » n'appelle pas la même réaction que « mot de passe du compte de service refusé »,
// qui ne se réparera jamais tout seul.
async function serviceToken(): Promise<{ token: string } | { reason: string }> {
  const username = process.env.RESA_CRON_USER;
  const password = process.env.RESA_CRON_PASSWORD;
  if (!username || !password) return { reason: "compte de service ResaMania non configuré" };
  try {
    const resa = await login({ username, password });
    return { token: resa.accessToken };
  } catch (e) {
    if (isResaUnavailable(e)) return { reason: "ResaMania indisponible, reporté au prochain passage" };
    if (isResaAuthRejected(e)) return { reason: "compte de service ResaMania : identifiants refusés" };
    console.error("[warm-planning] connexion du compte de service en échec:", e);
    return { reason: "compte de service ResaMania KO" };
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

/**
 * Efface les snapshots des jours révolus depuis plus de SNAPSHOT_RETENTION_DAYS. Le planning
 * d'un jour passé ne sert plus à personne, mais il contient le contactId ResaMania du
 * réservataire de chaque créneau — y compris de gens qui ne sont PAS membres de l'appli.
 * Comparaison de chaînes : les dates sont en "YYYY-MM-DD", dont l'ordre lexicographique EST
 * l'ordre chronologique. Best-effort : ne doit jamais faire échouer le préchauffage.
 */
async function purgeOldSnapshots(): Promise<number> {
  try {
    const { count } = await prisma.planningSnapshot.deleteMany({
      where: { date: { lt: dayISO(-SNAPSHOT_RETENTION_DAYS) } },
    });
    return count;
  } catch (e) {
    console.error("[warm-planning] purge des snapshots impossible", e);
    return 0;
  }
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  // Purge AVANT tout le reste, et surtout avant le garde « compte de service » : la rétention
  // est une promesse faite aux gens, elle ne doit pas dépendre de la santé de ResaMania. Si on
  // la mettait en fin de fonction, une panne du compte de service ferait sortir le cron en
  // amont et les snapshots — qui portent le contactId de tiers — s'accumuleraient sans fin.
  const purged = await purgeOldSnapshots();

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
  await recordCronRun(
    "warm-planning",
    true,
    `${warmed}/${dates.length} jours${purged ? `, ${purged} purgé(s)` : ""}`,
  );
  return NextResponse.json({ warmed, total: dates.length, purged });
}
