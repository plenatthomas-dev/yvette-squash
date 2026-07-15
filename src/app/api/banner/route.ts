import { NextRequest, NextResponse } from "next/server";
import { getBanner, getBannerSeen } from "@/lib/settings";
import { getLiveSessionUserId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/banner — bannière d'annonce courante (PUBLIC : le bandeau s'affiche pour tous, y
// compris hors connexion). `{ banner: null }` si aucune.
//
// Pour un membre CONNECTÉ, renvoie aussi ce qu'il a déjà masqué (`seen`) : le masquage est
// rattaché au compte, pas au navigateur — il suit le membre d'un appareil à l'autre et ne fuit
// jamais vers un autre membre du même téléphone. Hors connexion : pas de modale (elle
// recouvrirait l'écran de login) et masquage du bandeau géré en local par le navigateur.
//
// `authenticated`/`seen` ne servent QU'À l'affichage — la route ne renvoie que du contenu
// public, jamais une décision d'autorisation.
//
// no-store explicite : une annonce doit apparaître (et disparaître) tout de suite ; sans en-tête,
// la réponse pourrait être resservie depuis le cache du navigateur ou du CDN.
export async function GET(req: NextRequest) {
  const [banner, userId] = await Promise.all([
    getBanner(),
    getLiveSessionUserId(req.cookies.get("sid")?.value),
  ]);
  const seen = userId ? await getBannerSeen(userId) : null;
  return NextResponse.json(
    { banner, authenticated: userId !== null, seen },
    { headers: { "Cache-Control": "no-store" } },
  );
}
