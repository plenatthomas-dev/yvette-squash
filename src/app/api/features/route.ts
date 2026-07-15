import { NextResponse } from "next/server";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/features — état effectif des fonctions (PUBLIC : l'écran de connexion en a besoin
// avant toute session, et ces flags voyagent déjà dans le bundle client via NEXT_PUBLIC_*).
// Sert uniquement à l'UI ; l'autorisation reste faite route par route côté serveur.
export async function GET() {
  return NextResponse.json({ features: await getFeatures() });
}
