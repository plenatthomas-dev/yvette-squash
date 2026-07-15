// Feature flags à deux étages :
//
//  1. les variables NEXT_PUBLIC_FEATURE_* donnent le DÉFAUT de l'environnement (prod = tout
//     OFF sauf ranking, Recette/dev = tout ON). Elles sont inlinées au build, donc lisibles
//     côté client comme côté serveur, et restent scopées à la branche sur Vercel ;
//  2. une ligne `AppSetting` « features » peut FORCER un flag ON ou OFF à chaud, sans
//     redéploiement (étape #9). Absence d'override = « auto » ⇒ on suit l'env.
//
// Règle env : un flag est ACTIVÉ uniquement si sa valeur vaut "1", "true" ou "on" (insensible
// à la casse). Absent ou toute autre valeur ⇒ DÉSACTIVÉ. Défaut « fail-safe » : rien de
// sensible n'est exposé tant qu'on ne l'active pas explicitement.
//
// L'override vit en base : si la base tombe, `features-server` retombe sur l'env — donc sur
// un défaut sûr, jamais sur un état indéterminé.
//
// NB : ce module ne doit rien importer de « server-only » (ni prisma, ni next/server) pour
// rester utilisable depuis les composants client. Le côté serveur est dans `features-server.ts`,
// le côté client dans `components/FeatureProvider.tsx`.

export const FEATURE_KEYS = [
  "tricount",
  "emailLogin",
  "directory",
  "delegation",
  "tournament",
  "ranking",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** État effectif de chaque fonction (ce que le code doit consulter). */
export type Features = Record<FeatureKey, boolean>;

/** Override runtime : `true`/`false` = forcé par l'admin, clé absente = « auto » (suit l'env). */
export type FeatureOverrides = Partial<Record<FeatureKey, boolean>>;

/** Libellés pour l'espace admin. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  tricount: "Frais partagés (Tricount)",
  emailLogin: "Connexion « email seul »",
  directory: "Annuaire des membres",
  delegation: "Délégation de droits",
  tournament: "Tournois internes",
  ranking: "Classement fédéral",
};

function isOn(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on";
}

// ⚠️ Chaque `process.env.NEXT_PUBLIC_*` doit être écrit en toutes lettres : c'est ce texte
// exact que Next remplace au build. Un accès dynamique (env[nom]) rendrait tout `undefined`
// côté client.
export const ENV_FEATURES: Features = {
  // Partage de frais (onglet « Frais » / tricount) : UI + routes /api/tricount/**.
  tricount: isOn(process.env.NEXT_PUBLIC_FEATURE_TRICOUNT),
  // Connexion « email seul » (OTP) : onglet de login + routes /api/auth/email/**.
  emailLogin: isOn(process.env.NEXT_PUBLIC_FEATURE_EMAIL_LOGIN),
  // Annuaire des membres (idée 6) : bouton « Membres » + route /api/directory.
  directory: isOn(process.env.NEXT_PUBLIC_FEATURE_DIRECTORY),
  // Délégation temporaire de droits (idée 4) : UI Réglages + routes /api/delegations/**
  // + prise en compte de `onBehalfOf` dans book/cancel-slot/bookings. Sensible (agit avec
  // le jeton d'un autre membre).
  delegation: isOn(process.env.NEXT_PUBLIC_FEATURE_DELEGATION),
  // Module d'organisation de tournois (idée 3) : UI « Tournoi » + routes /api/tournaments/**.
  tournament: isOn(process.env.NEXT_PUBLIC_FEATURE_TOURNAMENT),
  // Classement fédéral (squashnet.fr, source publique) : affiché dans l'annuaire et proposé
  // comme ordre par défaut des têtes de série au tournoi.
  ranking: isOn(process.env.NEXT_PUBLIC_FEATURE_RANKING),
};

/** État effectif = override s'il y en a un, sinon le défaut de l'environnement. */
export function resolveFeatures(overrides: FeatureOverrides, env: Features = ENV_FEATURES): Features {
  const out = {} as Features;
  for (const k of FEATURE_KEYS) out[k] = overrides[k] ?? env[k];
  return out;
}

/**
 * Lit un jeu d'overrides depuis une source non fiable (JSON en base, corps de requête).
 * Tolérant : ignore les clés inconnues et les valeurs non booléennes plutôt que de jeter —
 * une ligne corrompue doit dégrader vers « auto », pas casser l'appli.
 */
export function parseOverrides(raw: unknown): FeatureOverrides {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: FeatureOverrides = {};
  for (const k of FEATURE_KEYS) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

/** Garde de type pour valider une clé reçue d'un client. */
export function isFeatureKey(v: unknown): v is FeatureKey {
  return typeof v === "string" && (FEATURE_KEYS as readonly string[]).includes(v);
}
