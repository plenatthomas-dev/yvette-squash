export const runtime = "nodejs";
// Sinon Next prérendrait la route au build, et figerait l'APK du moment dans le déploiement.
export const dynamic = "force-dynamic";

// GET /squash-yvette.apk -> l'APK de la dernière Release GitHub (cf. android/README.md), servi
// par NOTRE domaine. Le lien github.com direct ne marchait pas sur un Pixel 8a (16/10/2026) :
// l'appli GitHub, installée, se déclare pour tous les liens github.com, ouvre le sien dans une
// petite fenêtre Chrome, et le téléchargement y reste bloqué à 100 %. Ici, aucune appli ne
// réclame le lien, et la PWA le garde dans sa propre fenêtre (même domaine, même portée).
//
// La Release reste la seule source : publier une version suffit, comme avant. Le CDN de Vercel
// garde le fichier une heure, après quoi la nouvelle version est servie.
const RELEASE_APK =
  "https://github.com/plenatthomas-dev/yvette-squash/releases/latest/download/squash-yvette.apk";

export async function GET() {
  const upstream = await fetch(RELEASE_APK, { cache: "no-store" }).catch(() => null);
  // GitHub injoignable : on y renvoie, faute de mieux (le lien direct marche hors appli GitHub).
  if (!upstream?.ok || !upstream.body) return Response.redirect(RELEASE_APK, 302);

  const headers = new Headers({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": 'attachment; filename="squash-yvette.apk"',
    "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  });
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { headers });
}
