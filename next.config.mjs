// Headers de sécurité appliqués à toutes les réponses (pages + API).
// Pas de CSP pour l'instant : le script de thème inline (layout.tsx) demanderait un
// hash/nonce — à faire si le besoin devient réel.
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
  // `ws` (driver Neon serverless, cf. lib/db.ts) casse si le bundler Next l'embarque dans
  // le chunk serveur (son assignation dynamique de `mask`/`unmask` ne survit pas au
  // bundling → "TypeError: b.mask is not a function" à l'exécution). On force Next à le
  // laisser en dépendance Node.js normale (require au runtime) au lieu de le bundler.
  serverExternalPackages: ["ws"],
  // Les appels vers ResaMania se font côté serveur (API routes), donc pas de souci CORS côté client.
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
