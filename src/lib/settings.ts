// Réglages applicatifs éditables sans redéploiement (store clé/valeur AppSetting, étape 2).
// Aujourd'hui : la bannière d'annonce et le blocage de l'appli. Les routes restent minces en
// s'appuyant sur ces helpers ; `value` est une chaîne opaque dont la forme dépend de la clé.

import { prisma } from "./db";

export const BANNER_MAX = 280;
export const BLOCK_MAX = 280;

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

// ─────────────────────────────────────────────────────────────────────────────
// Blocage de l'appli (« Appli en maintenance »), piloté depuis /admin.
//
// Quand il est actif, les MEMBRES ne peuvent plus ni se connecter ni réserver ; les ADMINS
// gardent un accès complet (c'est tout l'intérêt : intervenir pendant que l'appli est fermée).
// Volontairement distinct de la bannière `MaintenanceBanner`, qui, elle, est AUTOMATIQUE et
// signale une base injoignable — ici c'est une décision humaine, réversible d'un clic.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_KEY = "block";

export const BLOCK_DEFAULT_MESSAGE = "Appli en maintenance";

export type AppBlock = { message: string };

/**
 * Blocage courant, ou `null` si l'appli est ouverte. Ne jette jamais : un pépin de lecture doit
 * laisser l'appli OUVERTE (fail-open). C'est le bon défaut ici — se tromper en fermant le club
 * entier serait bien plus grave que de laisser passer quelqu'un pendant une panne de réglage.
 */
export async function getAppBlock(): Promise<AppBlock | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: BLOCK_KEY } });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as { enabled?: unknown; message?: unknown };
    if (parsed.enabled !== true) return null;
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : BLOCK_DEFAULT_MESSAGE;
    return { message };
  } catch (e) {
    console.error("[settings] lecture du blocage impossible — appli laissée ouverte", e);
    return null;
  }
}

/** Active le blocage avec ce message (vide → message par défaut). */
export async function setAppBlock(message: string, updatedById: string): Promise<void> {
  const value = JSON.stringify({
    enabled: true,
    message: (message.trim() || BLOCK_DEFAULT_MESSAGE).slice(0, BLOCK_MAX),
  });
  await prisma.appSetting.upsert({
    where: { key: BLOCK_KEY },
    create: { key: BLOCK_KEY, value, updatedById },
    update: { value, updatedById },
  });
}

/**
 * Rouvre l'appli. On CONSERVE la ligne (`enabled: false`) au lieu de la supprimer : le message
 * saisi reste pré-rempli dans /admin pour la prochaine fois.
 */
export async function clearAppBlock(message: string, updatedById: string): Promise<void> {
  const value = JSON.stringify({
    enabled: false,
    message: (message.trim() || BLOCK_DEFAULT_MESSAGE).slice(0, BLOCK_MAX),
  });
  await prisma.appSetting.upsert({
    where: { key: BLOCK_KEY },
    create: { key: BLOCK_KEY, value, updatedById },
    update: { value, updatedById },
  });
}

/** État brut pour l'écran d'admin : le switch ET le message, même blocage inactif. */
export async function getAppBlockSetting(): Promise<{ enabled: boolean; message: string }> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: BLOCK_KEY } });
    if (!row) return { enabled: false, message: BLOCK_DEFAULT_MESSAGE };
    const parsed = JSON.parse(row.value) as { enabled?: unknown; message?: unknown };
    return {
      enabled: parsed.enabled === true,
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : BLOCK_DEFAULT_MESSAGE,
    };
  } catch {
    return { enabled: false, message: BLOCK_DEFAULT_MESSAGE };
  }
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
