import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { CRON_CADENCES, cronHealth, listCronRuns } from "@/lib/cron-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cron/health-summary
// Bilan de santé des crons, à faire appeler UNE FOIS PAR JOUR par cron-job.org avec
// « notifier en cas d'échec » : 200 si tout est à l'heure et vert, 503 sinon. C'est l'alerte
// gratuite qui manquait (audit 2026-10, point 5) — un cron arrêté ne se voyait que si un admin
// ouvrait /admin. Ne touche que la table `CronRun` (une lecture).
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }
  const health = cronHealth(await listCronRuns());
  // Les crons non surveillés (gestes d'admin, `interclub-standings` hors saison) ne comptent
  // pas : leur rouge est déjà visible dans /admin et ne dit rien d'une panne en cours.
  const problems = health
    .filter((c) => c.late || (!c.ok && c.name in CRON_CADENCES))
    .map((c) => ({ name: c.name, late: c.late, ok: c.ok, info: c.info, lastRunAt: c.lastRunAt }));
  return NextResponse.json(
    { ok: problems.length === 0, problems },
    { status: problems.length === 0 ? 200 : 503 },
  );
}

