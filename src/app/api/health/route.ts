import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health -> vérifie que l'app ET la base répondent (SELECT 1). Léger, sans auth.
// `dbMs` révèle la latence de réveil quand la base Neon sort de veille (cold start) : un
// premier appel après inactivité affichera un dbMs élevé, les suivants ~quelques ms.
// Sert au monitoring et, si on l'accepte (budget compute Neon), à un warm ping externe.
//
// ⚠️ NE PAS SUPPRIMER cette route même si le keep-alive externe (cron-job.org) est coupé : elle
// est utilisée par la bannière « Appli en maintenance » comme oracle de disponibilité de la base
// (cf. lib/apiFetch → isDbDown, components/MaintenanceBanner). Le CRON qui la pingue est distinct
// de la ROUTE : couper le ping ne nécessite pas de retirer l'endpoint (public, gratuit au repos).
// La détection dégrade proprement si on la retire quand même (404 → pas de faux positif), mais on
// perd alors la bannière hors du chemin de login.
export async function GET() {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, dbMs: Date.now() - t0 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
