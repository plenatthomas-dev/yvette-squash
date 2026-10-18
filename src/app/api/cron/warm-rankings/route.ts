import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, runCron } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { refreshRankings, summarizeRefresh } from "@/lib/squashnet/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s : la limite des fonctions Vercel (Fluid compute, plan Hobby compris). 60 s coupait les
// passes longues en plein milieu — toujours les mêmes membres, ceux de fin de liste.
export const maxDuration = 300;

const BUDGET_MS = 270_000;

// GET /api/cron/warm-rankings
// Rafraîchit le classement fédéral (squashnet.fr, source publique) des membres OPT-IN de
// l'annuaire (`listed`). Le cœur est partagé avec le bouton admin (cf. refreshRankings).
// Séquentiel (doux pour squashnet), idempotent. Mensuel (le classement bouge 1×/mois).
async function handle(req: NextRequest) {
  if (!(await getFeatures()).ranking) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  // Budget tenu SOUS `maxDuration` avec de la marge : à ~800 ms par joueur, 60 s ne couvraient
  // qu'une soixantaine de joueurs et la fonction était coupée sans heartbeat.
  const result = await refreshRankings({ budgetMs: BUDGET_MS });
  if (!result.month) {
    return NextResponse.json({ matched: 0, reason: "Période de classement introuvable." });
  }

  const { ok, info } = summarizeRefresh(result);
  await recordCronRun("warm-rankings", ok, info);
  const { month, members, matched, cleared, skipped, failed, bulkMoveBlocked } = result;
  return NextResponse.json({ month, members, matched, cleared, skipped, failed, bulkMoveBlocked });
}

// Filet commun (cf. lib/cron-run) : une exception laisse une trace `ok: false` au lieu du
// « ok » de la veille.
export const GET = (req: NextRequest) => runCron("warm-rankings", () => handle(req));
