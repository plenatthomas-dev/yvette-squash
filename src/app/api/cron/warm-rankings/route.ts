import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { refreshRankings } from "@/lib/squashnet/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/warm-rankings
// Rafraîchit le classement fédéral (squashnet.fr, source publique) des membres OPT-IN de
// l'annuaire (`listed`). Le cœur est partagé avec le bouton admin (cf. refreshRankings).
// Séquentiel (doux pour squashnet), idempotent. Mensuel (le classement bouge 1×/mois).
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).ranking) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const { month, members, matched, cleared } = await refreshRankings();
  if (!month) {
    return NextResponse.json({ matched: 0, reason: "Période de classement introuvable." });
  }

  await recordCronRun("warm-rankings", true, `${matched} rapproché(s), ${cleared} retiré(s)`);
  return NextResponse.json({ month, members, matched, cleared });
}
