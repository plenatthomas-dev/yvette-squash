// Réglages applicatifs éditables sans redéploiement (store clé/valeur AppSetting, étape 2).
// Pour l'instant : la bannière d'annonce. Les routes restent minces en s'appuyant sur ces
// helpers ; `value` est une chaîne opaque dont la forme dépend de la clé.

import { prisma } from "./db";

export const BANNER_MAX = 280;

export type BannerLevel = "info" | "warn";
export type Banner = {
  message: string;
  level: BannerLevel;
  // Version = updatedAt : sert au client à ré-afficher une bannière MODIFIÉE même si l'utilisateur
  // avait masqué la précédente (une nouvelle annonce doit repasser devant les yeux).
  version: string;
};

const BANNER_KEY = "banner";

/** Bannière courante, ou `null` si aucune (ou message vide). Ne jette jamais. */
export async function getBanner(): Promise<Banner | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: BANNER_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { message?: unknown; level?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (!message) return null;
    const level: BannerLevel = parsed.level === "warn" ? "warn" : "info";
    return { message, level, version: row.updatedAt.toISOString() };
  } catch {
    return null;
  }
}

/** Pose (ou remplace) la bannière. `updatedById` = admin qui l'a éditée (trace, pas de FK). */
export async function setBanner(
  message: string,
  level: BannerLevel,
  updatedById: string,
): Promise<void> {
  const value = JSON.stringify({ message: message.trim().slice(0, BANNER_MAX), level });
  await prisma.appSetting.upsert({
    where: { key: BANNER_KEY },
    create: { key: BANNER_KEY, value, updatedById },
    update: { value, updatedById },
  });
}

/** Retire la bannière (plus rien n'est affiché). */
export async function clearBanner(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: BANNER_KEY } });
}
