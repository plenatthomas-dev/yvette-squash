import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// Content-Security-Policy STRICTE À NONCE (idée #6 de l'audit sécurité).
//
// Objectif : contenir une éventuelle XSS. Auparavant la CSP était volontairement
// partielle (pas de script-src) pour ne pas casser le script de thème inline, Pico,
// le bootstrap de Next, Analytics/SpeedInsights et BotID. On la durcit ici avec la
// seule méthode qui marche en présence de scripts inline dynamiques : un NONCE par
// requête + `strict-dynamic`.
//
// Comment ça tient :
//  • On génère un nonce aléatoire à chaque requête et on le pose sur la CSP.
//  • Next.js lit ce nonce dans l'en-tête CSP de la requête et l'applique
//    AUTOMATIQUEMENT à tous les scripts qu'il rend (bootstrap, next/script, et donc
//    <Analytics/> + <SpeedInsights/>). Le seul script qu'on nonce à la main est le
//    script de thème inline (cf. app/layout.tsx, attribut `nonce`).
//  • `strict-dynamic` : une fois un script noncé exécuté, les scripts qu'IL charge
//    (insights, vitals, challenge BotID — tous proxifiés en same-origin par withBotId)
//    sont autorisés en cascade. Les navigateurs qui le comprennent ignorent alors la
//    liste d'hôtes/'self' de script-src ; les vieux navigateurs retombent sur 'self'.
//
// style-src garde 'unsafe-inline' : les styles inline de React (attribut style=…) et de
// Next ne sont pas contenables par nonce et ne sont pas un vecteur XSS exécutable. On
// durcit les SCRIPTS, pas les styles — c'est là qu'est le risque.
//
// ⚠️ Déploiement : tester d'abord sur la preview `recette` (console du navigateur = 0
// violation) avant de fusionner sur main. Pour une première passe d'observation sans
// rien bloquer, passer REPORT_ONLY à true : les violations sont journalisées par le
// navigateur sans casser la page.
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_ONLY = false;

// En PREVIEW Vercel uniquement : autorise la barre d'outils « Vercel Live » (feedback.js
// chargé depuis vercel.live + son temps réel via Pusher). Elle n'existe PAS en prod, donc on
// n'élargit jamais la CSP de production. ⚠️ Comme `strict-dynamic` fait ignorer aux navigateurs
// toute liste d'hôtes dans script-src, on ne peut pas « juste ajouter vercel.live » : en preview
// on retombe donc sur un script-src par hôte ('self' + nonce + vercel.live), SANS strict-dynamic.
// C'est acceptable : la preview n'est pas une frontière de sécurité, tout le reste est same-origin.
const IS_PREVIEW = process.env.VERCEL_ENV === "preview";

// En DÉVELOPPEMENT (`next dev`) uniquement : le HMR / runtime webpack et React Refresh
// s'appuient sur eval()/new Function(). Sans `'unsafe-eval'`, la CSP stricte bloque ce
// runtime → l'app ne s'hydrate jamais et reste figée sur l'écran de chargement. On l'ajoute
// donc au script-src EN DEV SEULEMENT — la prod (et les builds) restent sans `unsafe-eval`.
const IS_DEV = process.env.NODE_ENV !== "production";

function buildCsp(nonce: string): string {
  const live = IS_PREVIEW ? " https://vercel.live" : "";
  const evalDev = IS_DEV ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    // Prod : nonce + strict-dynamic (le plus strict). Preview : par hôte pour laisser passer
    // le script vercel.live, qui n'est pas noncé par Vercel donc bloqué par strict-dynamic.
    // Dev : + 'unsafe-eval' (HMR), jamais en prod.
    IS_PREVIEW
      ? `script-src 'self' 'nonce-${nonce}'${live}${evalDev}`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evalDev}`,
    // Styles inline (React/Next/Pico) non contenables par nonce, non exécutables.
    `style-src 'self' 'unsafe-inline'${live}`,
    `img-src 'self' data: blob:${IS_PREVIEW ? " https://vercel.live https://vercel.com" : ""}`,
    `font-src 'self'${IS_PREVIEW ? " https://vercel.live https://assets.vercel.com" : ""}`,
    // API interne + beacons Vercel (insights/vitals) + BotID : tous en same-origin.
    // Preview : + vercel.live et son websocket Pusher (temps réel de la barre d'outils).
    `connect-src 'self'${IS_PREVIEW ? " https://vercel.live https://*.pusher.com wss://*.pusher.com" : ""}`,
    "worker-src 'self'", // service worker /sw.js (web push)
    "manifest-src 'self'", // /manifest.webmanifest (PWA)
    // Preview : la barre d'outils s'affiche dans une iframe vercel.live. Prod : retombe sur default-src 'self'.
    ...(IS_PREVIEW ? ["frame-src 'self' https://vercel.live"] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(req: NextRequest) {
  // btoa(randomUUID) → nonce base64 (~122 bits d'entropie), sans dépendre de Buffer
  // (compatible edge comme node).
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  // Next.js lit le nonce depuis l'en-tête CSP DE LA REQUÊTE pour le propager à ses scripts.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(
    REPORT_ONLY ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
    csp,
  );
  return res;
}

// On ne fait tourner le middleware que sur les réponses HTML : pas les routes API (JSON,
// aucun script), ni les assets statiques Next, ni les fichiers publics (favicon, sw.js,
// logo…). Le nonce/CSP scripts n'a de sens que sur les pages.
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|.*\\.(?:jpe?g|png|svg|ico|webmanifest)$).*)",
  ],
};
