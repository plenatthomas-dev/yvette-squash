import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { tricountSummary } from "@/lib/tricount-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tricount/summary -> { globalCents, owedCount } : mon solde sur TOUT l'historique,
// et le nombre de tricounts qui attendent un remboursement de ma part (le badge €).
//
// Cette route existe pour ne plus charger l'historique complet afin d'en tirer un entier. Le
// badge est calculé à CHAQUE montage de la page, pour chaque membre : la route de liste, elle,
// ramène 25 tricounts avec leurs dépenses, leurs parts, leurs validations, leurs commentaires
// et leurs invités — un coût qui croît avec le nombre de membres plutôt qu'avec l'activité,
// exactement ce que PRODUCT.md proscrit.
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  return NextResponse.json(await tricountSummary(session.userId));
}
