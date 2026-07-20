"use client";

// Bannière « installer l'appli » : encourage les visiteurs (typiquement arrivés via le QR
// code / lien partagé) à installer l'appli plutôt que de la garder comme simple onglet.
//
// Trois cas, du meilleur au plus dégradé :
//  1) `beforeinstallprompt` reçu (Chrome/Edge, Android comme desktop) → vrai prompt natif au clic.
//  2) iOS Safari → aucune API d'installation ; on guide vers Partager ⬆ → « Sur l'écran d'accueil ».
//  3) Android sans event (SW pas encore prêt, heuristique d'engagement non atteinte, navigateur
//     non-Chromium…) → après un court délai, on affiche des instructions manuelles (menu ⋮).
//
// Jamais affichée si l'appli tourne déjà en standalone (déjà installée), et masquable
// (mémorisé en local : elle vit hors connexion, écran de login inclus).

import { useEffect, useState } from "react";

const SNOOZE_KEY = "installPromptSnooze";
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // 14 jours
// Délai avant de basculer sur les instructions manuelles Android si le prompt natif n'a pas
// été reçu. `beforeinstallprompt` peut arriver quelques secondes après le chargement (le SW
// doit s'activer + heuristique d'engagement de Chrome) : on lui laisse sa chance d'abord.
const ANDROID_FALLBACK_MS = 4000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Mode = "prompt" | "ios" | "android-manual";

function snoozed(): boolean {
  try {
    const t = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return Number.isFinite(t) && t > 0 && Date.now() - t < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()));
  } catch {
    /* localStorage indisponible : tant pis, la relance réapparaîtra au prochain chargement */
  }
}

// Déjà installée (lancée depuis l'écran d'accueil) ? `standalone` = iOS Safari (ancienne API).
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  // Chrome/Firefox/Edge sur iOS embarquent le moteur Safari mais n'exposent pas « Sur l'écran
  // d'accueil » de la même façon → on ne guide que le vrai Safari.
  const otherBrowser = /crios|fxios|edgios/i.test(ua);
  return ios && !otherBrowser;
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

export default function InstallAppPrompt() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || snoozed()) return;

    // Le service worker n'était enregistré qu'à l'activation des notifications push. Or Chrome
    // conditionne `beforeinstallprompt` à un SW actif AVEC un handler `fetch` (ajouté dans
    // /public/sw.js) : on l'enregistre donc aussi ici, silencieusement (aucune permission).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* pas bloquant : sans SW actif, Chrome ne proposera pas l'installation automatique */
      });
    }

    // Chromium (Android + desktop Chrome/Edge) : le vrai prompt d'installation. On l'écoute
    // partout — même sur desktop, où l'installation a du sens (raccourci appli).
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // on affiche NOTRE bannière plutôt que la mini-barre native
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("prompt"); // remplace un éventuel fallback manuel par le vrai prompt
    };
    const onInstalled = () => {
      snooze();
      setMode(null);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    if (isIosSafari()) {
      // Pas d'event possible sur iOS → instructions manuelles tout de suite.
      setMode("ios");
    } else if (isAndroid()) {
      // On laisse sa chance au prompt natif ; sinon, instructions manuelles (menu ⋮).
      fallbackTimer = setTimeout(() => {
        setMode((m) => m ?? "android-manual");
      }, ANDROID_FALLBACK_MS);
    }

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!mode) return null;

  const dismiss = () => {
    snooze();
    setMode(null);
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* prompt annulé ou indisponible */
    }
    // Accepté ou refusé : le prompt natif ne se relance pas tout seul, on se met en veille.
    snooze();
    setMode(null);
    setDeferred(null);
  };

  return (
    <div className="install-banner" role="status">
      <img src="/logo_squash.jpeg" alt="" aria-hidden="true" className="install-banner-icon" />
      <span className="install-banner-text">
        {mode === "prompt" && <>Installe l'appli pour l'ouvrir en un tap depuis ton écran d'accueil.</>}
        {mode === "android-manual" && (
          <>
            Installe l'appli : menu <strong>⋮</strong> du navigateur →{" "}
            <strong>Installer l'application</strong> (ou <strong>Ajouter à l'écran d'accueil</strong>).
          </>
        )}
        {mode === "ios" && (
          <>
            Installe l'appli : appuie sur <strong>Partager</strong> puis{" "}
            <strong>Sur l'écran d'accueil</strong>.
          </>
        )}
      </span>
      <span className="install-banner-actions">
        {mode === "prompt" && (
          <button type="button" onClick={install}>
            Installer
          </button>
        )}
        <button type="button" className="secondary" onClick={dismiss}>
          {mode === "prompt" ? "Plus tard" : "J'ai compris"}
        </button>
      </span>
    </div>
  );
}
