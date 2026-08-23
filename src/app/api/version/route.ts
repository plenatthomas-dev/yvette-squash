import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/version -> l'identifiant du build ACTUELLEMENT déployé (NEXT_PUBLIC_BUILD_ID,
// figé à la compilation — cf. next.config.mjs). Public, sans auth, léger.
//
// Sert d'oracle à UpdateReloader : un onglet resté ouvert depuis AVANT un déploiement tourne
// encore avec l'ancien JS, qui embarque l'ANCIEN build id ; le comparer à celui que renvoie
// cette route (toujours celui du déploiement courant, puisque la route elle-même tourne sur
// ce déploiement) révèle l'écart sans attendre un plantage.
export async function GET() {
  return NextResponse.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
