import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { getLiveFixtures } from "@/lib/interclub-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/live : état des rencontres du jour, pour les spectateurs.
//
// Réservé aux membres connectés, comme le reste de l'appli — on y lit des noms de joueurs.
// L'économie ne vient donc PAS d'un cache CDN (qui servirait la réponse à des requêtes non
// authentifiées, cf. l'avertissement en tête de `interclub-gate.ts`) mais du Data Cache côté
// serveur : la requête LOURDE — rencontres, matchs et jeux joints — est mutualisée entre tous
// les spectateurs.
//
// ⚠️ Ce qui reste à payer par sondage : `getSession` lit la table `Session` à chaque appel,
// sans cache. Dix spectateurs coûtent donc dix lectures légères, et non une seule — le module
// qu'appelle cette route le dit noir sur blanc (`interclub-gate.ts`), et c'est pourtant cette
// route-ci qu'on lit en premier. C'est aussi pourquoi le sondage client s'arrête quand il n'y a
// rien à voir (cf. InterclubLive) : à ce prix-là, le nombre de sondages compte.
//
// `no-store` est explicite : il interdit à tout cache PARTAGÉ de retenir cette réponse.
export async function GET(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const fixtures = await getLiveFixtures();
  return NextResponse.json(
    { fixtures },
    { headers: { "Cache-Control": "no-store" } },
  );
}
