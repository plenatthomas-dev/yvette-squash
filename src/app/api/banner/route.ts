import { NextResponse } from "next/server";
import { getBanner } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/banner — bannière d'annonce courante (PUBLIC : affichée en haut de l'appli pour
// tous, y compris hors connexion). `{ banner: null }` si aucune.
// no-store explicite : une annonce doit apparaître (et disparaître) tout de suite ; sans en-tête,
// la réponse pourrait être resservie depuis le cache du navigateur ou du CDN.
export async function GET() {
  return NextResponse.json(
    { banner: await getBanner() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
