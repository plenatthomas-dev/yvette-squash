"use client";

// Où tourne l'appli : dans l'appli Android (TWA, cf. android/README.md), installée sur Android
// (TWA ou PWA), ou dans un simple onglet.

const ANDROID_APP_KEY = "launchedFromAndroidApp";
// Celui de android/twa-manifest.json (`packageId`), et des `related_applications` du manifest.
const ANDROID_APP_PACKAGE = "fr.squashyvette.app";

/**
 * Lancée par l'appli Android (TWA) ? Chrome y donne pour référent `android-app://<package>/`,
 * mais au PREMIER chargement seulement : on le retient pour la session, sinon la réponse
 * changerait au premier rechargement. Le package est vérifié : un lien ouvert depuis Gmail ou
 * WhatsApp peut arriver avec le référent `android-app://` de cette appli-là.
 */
export function isAndroidApp(): boolean {
  if (typeof document === "undefined") return false;
  const fromApp = document.referrer.startsWith(`android-app://${ANDROID_APP_PACKAGE}`);
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
  return standaloneOnAndroid();
}

/** La PWA ajoutée à l'écran d'accueil depuis Chrome Android (une WebAPK), pas l'appli Android. */
export function isAndroidPwa(): boolean {
  if (typeof window === "undefined") return false;
  return standaloneOnAndroid() && !isAndroidApp();
}

function standaloneOnAndroid(): boolean {
  const android = /android/i.test(navigator.userAgent);
  const standalone =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return android && standalone;
}

type RelatedApp = { platform: string; id?: string };

/**
 * L'appli Android est-elle installée sur ce téléphone ? Chrome Android seulement, et à deux
 * conditions : le manifest web la cite (`related_applications`), et l'APK cite le site
 * (`asset_statements`, posé par Bubblewrap). Sans réponse possible : `false`.
 */
export async function androidAppInstalled(): Promise<boolean> {
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };
  if (typeof nav.getInstalledRelatedApps !== "function") return false;
  try {
    const apps = await nav.getInstalledRelatedApps();
    return apps.some((a) => a.platform === "play" && a.id === ANDROID_APP_PACKAGE);
  } catch {
    return false;
  }
}
