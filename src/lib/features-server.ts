// Côté SERVEUR des feature flags runtime (étape #9) : lit les overrides posés par l'admin
// dans `AppSetting["features"]` et les combine au défaut de l'environnement (cf. features.ts).
//
// C'est la SEULE source qui fait autorité : le client peut mentir, les routes API doivent
// appeler `getFeatures()`. Ne jamais importer ce module depuis un composant client (prisma).

import { prisma } from "./db";
import {
  ENV_FEATURES,
  parseOverrides,
  resolveFeatures,
  type FeatureKey,
  type FeatureOverrides,
  type Features,
} from "./features";

const FEATURES_KEY = "features";

// Cache mémoire par instance de fonction : sans lui, chaque appel d'API paierait un aller-retour
// Neon rien que pour lire un flag. Contrepartie assumée : un basculement depuis /admin met
// jusqu'à TTL_MS à se propager aux instances déjà chaudes.
const TTL_MS = 15_000;
let cache: { at: number; overrides: FeatureOverrides } | null = null;

/** Force la relecture au prochain appel (après une écriture admin, sur l'instance qui écrit). */
export function invalidateFeatureCache(): void {
  cache = null;
}

/**
 * Overrides courants. Ne jette jamais : une base indisponible ou une valeur corrompue
 * renvoie `{}` ⇒ on retombe sur l'environnement, c'est-à-dire sur le défaut fail-safe.
 */
export async function getFeatureOverrides(): Promise<FeatureOverrides> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.overrides;
  let overrides: FeatureOverrides = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: FEATURES_KEY } });
    if (row) overrides = parseOverrides(JSON.parse(row.value));
  } catch (e) {
    // Base KO ou JSON illisible → on garde `{}` (= tout en « auto »). On trace mais on sert.
    console.error("[features] lecture des overrides impossible, repli sur l'env", e);
  }
  cache = { at: now, overrides };
  return overrides;
}

/** État effectif des fonctions, à consulter dans toute route API. */
export async function getFeatures(): Promise<Features> {
  return resolveFeatures(await getFeatureOverrides());
}

/**
 * Pose (`true`/`false`) ou retire (`null` = retour à « auto ») l'override d'un flag.
 * Renvoie les overrides résultants. `updatedById` = admin auteur (trace, pas de FK).
 */
export async function setFeatureOverride(
  key: FeatureKey,
  value: boolean | null,
  updatedById: string,
): Promise<FeatureOverrides> {
  const current = await getFeatureOverrides();
  const next: FeatureOverrides = { ...current };
  if (value === null) delete next[key];
  else next[key] = value;

  const json = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: FEATURES_KEY },
    create: { key: FEATURES_KEY, value: json, updatedById },
    update: { value: json, updatedById },
  });
  cache = { at: Date.now(), overrides: next };
  return next;
}

/** Défauts d'environnement, ré-exportés pour que l'admin puisse afficher ce que vaut « auto ». */
export { ENV_FEATURES };
