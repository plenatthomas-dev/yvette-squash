"use client";

// Où tourne l'appli : dans l'appli Android (TWA, cf. android/README.md), installée sur Android
// (TWA ou PWA), ou dans un simple onglet.

const ANDROID_APP_KEY = "launchedFromAndroidApp";

/**
 * Lancée par l'appli Android (TWA) ? Chrome y donne pour référent `android-app://<package>/`,
 * mais au PREMIER chargement seulement : on le retient pour la session, sinon la réponse
 * changerait au premier rechargement.
 */
export function isAndroidApp(): boolean {
  if (typeof document === "undefined") return false;
  const fromApp = document.referrer.startsWith("android-app://");
  try {
    if (fromApp) sessionStorage.setItem(ANDROID_APP_KEY, "1");
    return fromApp || sessionStorage.getItem(ANDROID_APP_KEY) === "1";
  } catch {
    return fromApp;
  }
}

/**
 * Installée sur Android, qu'il s'agisse de l'appli du Play Store (TWA) ou de la PWA ajoutée à
 * l'écran d'accueil : un contexte SANS barre d'adresse ni bouton « précédent », où le retour
 * du système est la seule navigation arrière.
 */
export function runsAsInstalledAndroidApp(): boolean {
  if (typeof window === "undefined") return false;
  if (isAndroidApp()) return true;
  const android = /android/i.test(navigator.userAgent);
  const standalone =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return android && standalone;
}
