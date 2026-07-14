import { withBotId } from "botid/next/config";

// CSP partielle SÛRE : on ne pose QUE les directives sans incidence sur le contenu inline.
// On ne met volontairement PAS de `default-src` (il retomberait sur script-src/style-src et
// casserait le script de thème inline, les styles Pico et le bootstrap inline de Next). Une
// CSP stricte des scripts demanderait un nonce via middleware (Next + Analytics/SpeedInsights)
// → reporté. Ces 4 directives ferment quand même : cadrage (clickjacking), balise <base>
// injectée, plugins/objets, et cible des formulaires — sans aucun risque de casse.
const csp = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

// Headers de sécurité appliqués à toutes les réponses (pages + API).
const securityHeaders = [
  // Interdit d'embarquer l'appli dans une iframe (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Empêche le navigateur de « deviner » un type MIME différent de celui annoncé.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // N'envoie que l'origine (pas l'URL complète, qui contient ?date=…) aux sites tiers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // L'appli n'utilise ni caméra, ni micro, ni géoloc : on le déclare.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Défense en profondeur (cf. commentaire csp ci-dessus).
  { key: "Content-Security-Policy", value: csp },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Les appels vers ResaMania se font côté serveur (API routes), donc pas de souci CORS côté client.
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

// withBotId : pose le proxy/rewrites nécessaires à Vercel BotID (détection de bots invisible)
// sur les endpoints protégés déclarés dans src/instrumentation-client.ts.
export default withBotId(nextConfig);
