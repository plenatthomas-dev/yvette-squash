// CONTRÔLE DES VARIABLES D'ENVIRONNEMENT AU BUILD DE PRODUCTION (audit 2026-10, point 6).
//
// Une variable manquante ne se voyait qu'au runtime, et parfois sans bruit : sans
// `CREDENTIALS_SECRET`, aucun jeton ne se déchiffre et TOUTES les sessions sont supprimées
// une à une, sans une ligne de log lisible pour l'admin. Sans `CRON_SECRET`, les crons
// échouent fermés. Mieux vaut un déploiement refusé qu'une production qui démarre cassée.
//
// Appelé par next.config.mjs ; ne bloque QUE lorsque `VERCEL_ENV === "production"` — les
// préviews et le poste local gardent la liberté de tourner partiellement configurés.

/** Variables sans lesquelles la production ne fonctionne pas. */
export const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "DIRECT_URL",
  "CREDENTIALS_SECRET",
  "CRON_SECRET",
  "RESA_CLIENT_ID",
  "RESA_CLIENT_SECRET",
];

/**
 * Rend la liste des problèmes (vide = tout va bien). Pur, pour les tests.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function envProblems(env) {
  const problems = [];
  for (const name of REQUIRED_IN_PRODUCTION) {
    if (!(env[name] ?? "").trim()) problems.push(`${name} manquante`);
  }
  const secret = (env.CREDENTIALS_SECRET ?? "").trim();
  if (secret && Buffer.from(secret, "base64").length !== 32) {
    problems.push("CREDENTIALS_SECRET doit faire 32 octets une fois décodée (openssl rand -base64 32)");
  }
  if (!(env.ADMIN_USER_IDS ?? "").trim() && !(env.ADMIN_EMAILS ?? "").trim()) {
    problems.push("ni ADMIN_USER_IDS ni ADMIN_EMAILS : personne ne serait admin");
  }
  if ((env.RESA_USE_MOCK ?? "") === "1") {
    problems.push("RESA_USE_MOCK=1 : la production afficherait un planning factice");
  }
  return problems;
}

/**
 * Lève si la production est mal configurée. Sans effet hors production Vercel.
 * @param {Record<string, string | undefined>} env
 */
export function assertProductionEnv(env = process.env) {
  if (env.VERCEL_ENV !== "production") return;
  const problems = envProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Configuration de production incomplète — build refusé :\n  - ${problems.join("\n  - ")}`,
    );
  }
}
