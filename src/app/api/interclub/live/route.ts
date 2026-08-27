import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { getLiveFixtures } from "@/lib/interclub-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/live : état des rencontres du jour, pour les spectateurs.
//
// Réservé aux membres connectés, comme le reste de l'appli — on y lit des noms de joueurs.
// L'économie ne vient donc PAS d'un cache CDN (qui servirait la réponse à des requêtes non
// authentifiées, cf. l'avertissement en tête de `interclub-gate.ts`) mais du Data Cache côté
// serveur : dix spectateurs qui interrogent coûtent une seule lecture Postgres.
//
// `no-store` est explicite : il interdit à tout cache PARTAGÉ de retenir cette réponse.
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const fixtures = await getLiveFixtures();
  return NextResponse.json(
    { fixtures },
    { headers: { "Cache-Control": "no-store" } },
  );
}
