import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { refreshRankings } from "@/lib/squashnet/refresh";

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

  const { month, members, matched, cleared } = await refreshRankings();
  if (!month) {
    return NextResponse.json(
      { error: "Période de classement introuvable (squashnet indisponible ?)." },
      { status: 502 },
    );
  }

  // Met à jour le heartbeat partagé avec le cron : le tableau de bord reflète cette fraîcheur.
  await recordCronRun("warm-rankings", true, `${matched} rapproché(s), ${cleared} retiré(s) · manuel`);
  return NextResponse.json({ month, members, matched, cleared });
}
