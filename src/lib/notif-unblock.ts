// Débloquer des notifications REFUSÉES : le chemin exact, appareil par appareil.
//
// Une fois le refus enregistré, aucun navigateur ne laisse un site redemander l'autorisation :
// `Notification.requestPermission()` répond « denied » sans rien afficher. Le seul chemin passe
// par les réglages — et c'est là que les membres se perdaient. L'ancien message disait « dans
// les réglages du navigateur » à quelqu'un qui, dans l'appli Android, n'a même pas de
// navigateur sous les yeux : sur la TWA, l'autorisation se règle dans les réglages ANDROID de
// l'appli, pas dans Chrome. On donne donc le chemin de CET appareil, en trois gestes, et
// l'appli termine elle-même l'activation au retour (cf. `restoreWantedPush`).

import { isAndroidApp } from "@/lib/androidApp";
// La liste vit dans le module pur : la route serveur qui valide les relevés s'en sert aussi.
import type { NotifPlatform } from "@/lib/notif-state";
export type { NotifPlatform };

export type UnblockGuide = { steps: string[]; hints?: string[] };

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
        // Chrome ne relit le réglage d'Android qu'au LANCEMENT de l'appli.
        hints: ["Rien ne change au retour ? Ferme complètement l'appli (écran des applis récentes) et rouvre-la depuis son icône."],
      };
    case "android-pwa":
      return {
        steps: [
          "Appui long sur l'icône « Squash Yvette » de l'écran d'accueil, puis ⓘ (Infos sur l'appli).",
          "Notifications → active-les.",
          RETOUR_AUTO,
        ],
        hints: [`Toujours bloqué ? Chrome → ⋮ → Paramètres → Paramètres des sites → Notifications → ${host} → Autoriser.`],
      };
    case "android":
      return {
        steps: [
          "Touche l'icône à gauche de l'adresse, tout en haut (⚙ ou 🔒).",
          "Autorisations → Notifications → active-les.",
          RETOUR_AUTO,
        ],
        hints: [
          // LE PIÈGE DE L'APPLI INSTALLÉE (Pixel 8a, 14/10/2026). Une fois l'appli Android
          // installée, c'est ELLE qui décide des notifications du site, onglets Chrome compris —
          // et Chrome ne relit son réglage qu'au lancement de l'appli. Rétablies dans les
          // réglages d'Android, elles restaient donc « bloquées » ici, et la page Chrome du site
          // renvoyait vers un réglage déjà actif.
          "Tu as installé l'appli Squash Yvette ? C'est elle qui décide : active ses notifications (appui long sur l'icône → ⓘ → Notifications), puis ouvre l'appli depuis son icône — Chrome ne relit ce réglage qu'à son lancement.",
          "Toujours bloqué ? Réglages Android → Applis → Chrome → Notifications → active-les.",
        ],
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
        hints: ["Toujours rien ? Le système peut couper le navigateur entier : Paramètres de Windows / macOS → Notifications."],
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
