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

/**
 * Pose (ou remplace) la bannière. `updatedById` = admin qui l'a éditée (trace, pas de FK).
 *
 * IDEMPOTENT : réenregistrer un message identique ne touche à RIEN. La `version` d'une annonce
 * est son `updatedAt` ; la bouger invalide les masquages de TOUS les membres et leur remet la
 * modale devant les yeux. Un double-clic sur « Enregistrer », ou une correction annulée, ne doit
 * pas déranger le club entier. Un vrai changement (texte OU couleur) repasse bien devant tous.
 */
export async function setBanner(
  message: string,
  level: BannerLevel,
  updatedById: string,
): Promise<void> {
  const value = JSON.stringify({ message: message.trim().slice(0, BANNER_MAX), level });
  const current = await prisma.appSetting.findUnique({
    where: { key: BANNER_KEY },
    select: { value: true },
  });
  if (current?.value === value) return; // rien de neuf : on ne rejoue pas l'annonce
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

/** Ce que ce membre a déjà masqué : versions du bandeau fermé / de la modale vue. */
export type BannerSeen = { dismissedVersion: string | null; modalSeenVersion: string | null };

/** Masquages du membre. Ne jette jamais : en cas de pépin on réaffiche (plutôt que de taire). */
export async function getBannerSeen(userId: string): Promise<BannerSeen> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannerDismissedVersion: true, bannerModalSeenVersion: true },
    });
    return {
      dismissedVersion: u?.bannerDismissedVersion ?? null,
      modalSeenVersion: u?.bannerModalSeenVersion ?? null,
    };
  } catch (e) {
    console.error("[settings] lecture des masquages d'annonce impossible", e);
    return { dismissedVersion: null, modalSeenVersion: null };
  }
}

/**
 * Enregistre que ce membre a fermé le bandeau (`what: "banner"`) ou vu la modale
 * (`what: "modal"`) pour CETTE version de l'annonce. Les deux sont indépendants.
 */
export async function setBannerSeen(
  userId: string,
  what: "banner" | "modal",
  version: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data:
      what === "banner"
        ? { bannerDismissedVersion: version }
        : { bannerModalSeenVersion: version },
  });
}
