import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { refreshRankings, summarizeRefresh } from "@/lib/squashnet/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/admin/refresh-rankings
// Déclenche À LA DEMANDE le rafraîchissement du classement fédéral (squashnet.fr) de tous les
// membres listés — même logique que le cron mensuel warm-rankings, mais piloté par un admin.
// Utile quand de nouveaux inscrits n'ont pas encore de classement (le cron ne repasse qu'une
// fois par mois). Accès réservé aux admins (allowlist ADMIN_EMAILS) + flag `ranking`.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  if (!(await getFeatures()).ranking) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }

  const result = await refreshRankings();
  if (!result.month) {
    return NextResponse.json(
      { error: "Période de classement introuvable (squashnet indisponible ?)." },
      { status: 502 },
    );
  }

  // Heartbeat sous une clé DISTINCTE du cron planifié : un rafraîchissement manuel ne doit pas
  // repasser au vert la ligne « warm-rankings » du tableau de bord et masquer une panne du cron.
  const { ok, info } = summarizeRefresh(result);
  await recordCronRun("warm-rankings-manuel", ok, info);
  const { month, members, matched, cleared, skipped, failed, bulkMoveBlocked } = result;
  // On renvoie `ok` (même critère que le heartbeat) pour que l'UI n'affiche pas un faux succès
  // vert quand squashnet est muet (tous `skipped`) sans échec base ni blocage.
  return NextResponse.json({ ok, month, members, matched, cleared, skipped, failed, bulkMoveBlocked });
}
