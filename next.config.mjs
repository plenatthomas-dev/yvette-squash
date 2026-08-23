import { withBotId } from "botid/next/config";

// Identifiant de build, figé UNE FOIS à la compilation (jamais recalculé au runtime) et
// inliné aussi bien côté client que côté serveur via `env` ci-dessous. Sert à détecter un
// onglet resté ouvert depuis AVANT un déploiement (cf. UpdateBanner) : le commit Vercel s'il
// est connu, sinon un horodatage — dans les deux cas, une valeur différente à chaque build.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

// Headers de sécurité appliqués à toutes les réponses (pages + API).
// NB : la Content-Security-Policy N'EST PLUS ICI — elle est posée par src/middleware.ts
// (CSP stricte à nonce + strict-dynamic). La mettre aussi ici créerait un DEUXIÈME en-tête
// CSP, et le navigateur appliquerait l'intersection des deux → casse. Une seule source.
const securityHeaders = [
  // Interdit d'embarquer l'appli dans une iframe (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Empêche le navigateur de « deviner » un type MIME différent de celui annoncé.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // N'envoie que l'origine (pas l'URL complète, qui contient ?date=…) aux sites tiers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // L'appli n'utilise ni caméra, ni micro, ni géoloc : on le déclare.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  // Les appels vers ResaMania se font côté serveur (API routes), donc pas de souci CORS côté client.
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

// withBotId : pose le proxy/rewrites nécessaires à Vercel BotID (détection de bots invisible)
// sur les endpoints protégés déclarés dans src/instrumentation-client.ts.
export default withBotId(nextConfig);
