"use client";

// Bannière « installer l'appli » : encourage les visiteurs (typiquement arrivés via le QR
// code / lien partagé) à installer l'appli sur leur téléphone plutôt que de la garder comme
// simple onglet de navigateur. Mobile uniquement (le manifest la rend installable, mais
// l'installation n'a de sens que sur téléphone) :
//  - Android/Chrome : capte `beforeinstallprompt` et déclenche le vrai prompt natif au clic.
//  - iOS Safari : aucune API d'installation programmatique n'existe → on guide vers
//    Partager ⬆ → « Sur l'écran d'accueil ».
// Jamais affichée si l'appli tourne déjà en standalone (déjà installée), et masquable
// (mémorisé en local, pas de compte : elle vit hors connexion, sur l'écran de login inclus).

import { useEffect, useState } from "react";

const SNOOZE_KEY = "installPromptSnooze";
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // 14 jours

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

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
  // Chrome/Firefox sur iOS embarquent quand même le moteur Safari mais n'ont pas accès à
  // « Sur l'écran d'accueil » de la même façon → on ne guide que le vrai Safari.
  const otherBrowser = /crios|fxios|edgios/i.test(ua);
  return ios && !otherBrowser;
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

export default function InstallAppPrompt() {
  const [mode, setMode] = useState<"android" | "ios" | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || snoozed()) return;

    if (isIosSafari()) {
      setMode("ios");
      return;
    }

    if (!isAndroid()) return; // desktop, ou plateforme mobile non gérée → rien à proposer

    // Jusqu'ici le service worker n'était enregistré qu'à l'activation des notifications push.
    // Or Chrome conditionne souvent `beforeinstallprompt` à un SW actif : on l'enregistre donc
    // aussi ici, silencieusement (aucune permission demandée, juste l'enregistrement).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* pas bloquant : sans SW actif, Chrome proposera peut-être moins vite l'installation */
      });
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // on affiche notre propre bannière plutôt que la mini-barre native
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("android");
    };
    const onInstalled = () => {
      setMode(null);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
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
        {mode === "android" ? (
          <>Installe l'appli sur ton téléphone pour l'ouvrir en un tap.</>
        ) : (
          <>
            Installe l'appli : appuie sur <strong>Partager</strong> puis{" "}
            <strong>Sur l'écran d'accueil</strong>.
          </>
        )}
      </span>
      <span className="install-banner-actions">
        {mode === "android" && (
          <button type="button" onClick={install}>
            Installer
          </button>
        )}
        <button type="button" className="secondary" onClick={dismiss}>
          {mode === "android" ? "Plus tard" : "J'ai compris"}
        </button>
      </span>
    </div>
  );
}
