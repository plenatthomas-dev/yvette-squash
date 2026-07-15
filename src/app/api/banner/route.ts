import { NextRequest, NextResponse } from "next/server";
import { getBanner } from "@/lib/settings";
import { hasLiveSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/banner — bannière d'annonce courante (PUBLIC : le bandeau s'affiche pour tous, y
// compris hors connexion). `{ banner: null }` si aucune.
//
// `authenticated` ne sert QU'À l'affichage : la modale (intrusive) est réservée aux membres
// connectés, pour ne pas recouvrir l'écran de connexion. Ce n'est pas une autorisation — la
// route ne renvoie de toute façon que du contenu public.
//
// no-store explicite : une annonce doit apparaître (et disparaître) tout de suite ; sans en-tête,
// la réponse pourrait être resservie depuis le cache du navigateur ou du CDN.
export async function GET(req: NextRequest) {
  const [banner, authenticated] = await Promise.all([
    getBanner(),
    hasLiveSession(req.cookies.get("sid")?.value),
  ]);
  return NextResponse.json(
    { banner, authenticated },
    { headers: { "Cache-Control": "no-store" } },
  );
}
