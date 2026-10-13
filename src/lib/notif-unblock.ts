// Débloquer des notifications REFUSÉES : le chemin exact, appareil par appareil.
//
// Une fois le refus enregistré, aucun navigateur ne laisse un site redemander l'autorisation :
// `Notification.requestPermission()` répond « denied » sans rien afficher. Le seul chemin passe
// par les réglages — et c'est là que les membres se perdaient. L'ancien message disait « dans
// les réglages du navigateur » à quelqu'un qui, dans l'appli Android, n'a même pas de
// navigateur sous les yeux : sur la TWA, l'autorisation se règle dans les réglages ANDROID de
// l'appli, pas dans Chrome. On donne donc le chemin de CET appareil, en trois gestes, et
// l'appli termine elle-même l'activation au retour (cf. `resumeUnblockedPush`).

import { isAndroidApp } from "@/lib/androidApp";

export type NotifPlatform =
  | "android-app" // appli du Play Store (TWA) : notifications déléguées à l'appli Android
  | "android-pwa" // PWA ajoutée à l'écran d'accueil depuis Chrome
  | "android" // onglet Chrome (ou autre navigateur) sur Android
  | "ios" // iPhone / iPad (seule la PWA reçoit des notifications)
  | "firefox"
  | "safari" // Safari sur Mac
  | "desktop"; // Chrome, Edge et autres Chromium sur ordinateur

export type UnblockGuide = { steps: string[]; hint?: string };

/** Pur, pour être testé sans navigateur. Voir `currentNotifPlatform` pour la version branchée. */
export function detectNotifPlatform(
  ua: string,
  opts: { androidApp?: boolean; standalone?: boolean; maxTouchPoints?: number } = {},
): NotifPlatform {
  if (/android/i.test(ua)) {
    if (opts.androidApp) return "android-app";
    return opts.standalone ? "android-pwa" : "android";
  }
  // iPadOS se présente comme un Mac : seul l'écran tactile le trahit.
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (opts.maxTouchPoints ?? 0) > 1)) {
    return "ios";
  }
  if (/firefox\//i.test(ua)) return "firefox";
  if (/safari\//i.test(ua) && !/chrome|chromium|edg\//i.test(ua)) return "safari";
  return "desktop";
}

const RETOUR_AUTO = "Reviens ici : l'activation se termine toute seule.";

export function unblockGuide(platform: NotifPlatform, host: string): UnblockGuide {
  switch (platform) {
    case "android-app":
      return {
        steps: [
          "Appui long sur l'icône « Squash Yvette » de l'écran d'accueil, puis ⓘ (Infos sur l'appli).",
          "Notifications → active-les.",
          RETOUR_AUTO,
        ],
        hint: "Rien ne change au retour ? Ferme complètement l'appli et rouvre-la.",
      };
    case "android-pwa":
      return {
        steps: [
          "Appui long sur l'icône « Squash Yvette » de l'écran d'accueil, puis ⓘ (Infos sur l'appli).",
          "Notifications → active-les.",
          RETOUR_AUTO,
        ],
        hint: `Toujours bloqué ? Chrome → ⋮ → Paramètres → Paramètres des sites → Notifications → ${host} → Autoriser.`,
      };
    case "android":
      return {
        steps: [
          "Touche l'icône à gauche de l'adresse, tout en haut (⚙ ou 🔒).",
          "Autorisations → Notifications → active-les.",
          RETOUR_AUTO,
        ],
        hint: "Toujours bloqué ? Réglages Android → Applis → Chrome → Notifications → active-les.",
      };
    case "ios":
      return {
        steps: [
          "Ouvre l'appli Réglages de l'iPhone → Notifications.",
          "Choisis « Squash Yvette » → active « Autoriser les notifications ».",
          RETOUR_AUTO,
        ],
      };
    case "firefox":
      return {
        steps: [
          "Clique sur l'icône à gauche de l'adresse (🔒 ou cloche barrée).",
          "En face de « Envoyer des notifications — Bloqué », clique sur ✕.",
          "Reviens ici et presse « Activer les notifications ».",
        ],
      };
    case "safari":
      return {
        steps: [
          "Menu Safari → Réglages… → Sites web → Notifications.",
          `En face de ${host}, choisis « Autoriser ».`,
          RETOUR_AUTO,
        ],
      };
    case "desktop":
      return {
        steps: [
          "Clique sur l'icône à gauche de l'adresse (⚙ ou 🔒).",
          "Active « Notifications » (ou « Réinitialiser l'autorisation »).",
          RETOUR_AUTO,
        ],
        hint: "Toujours rien ? Le système peut couper le navigateur entier : Paramètres de Windows / macOS → Notifications.",
      };
  }
}

/** La plateforme de CET appareil — côté client uniquement (à lire dans un effet). */
export function currentNotifPlatform(): NotifPlatform {
  const standalone =
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return detectNotifPlatform(navigator.userAgent, {
    androidApp: isAndroidApp(),
    standalone,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}
