import { NextResponse } from "next/server";
import { getBanner } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/banner — bannière d'annonce courante (PUBLIC : affichée en haut de l'appli pour
// tous, y compris hors connexion). `{ banner: null }` si aucune.
export async function GET() {
  return NextResponse.json({ banner: await getBanner() });
}
