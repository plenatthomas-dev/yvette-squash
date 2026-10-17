"use client";

// Bannière « installer l'appli » : encourage les visiteurs (typiquement arrivés via le QR
// code / lien partagé) à installer l'appli plutôt que de la garder comme simple onglet.
//
// Deux cas :
//  1) `beforeinstallprompt` reçu (Chrome/Edge sur ordinateur) → vrai prompt natif au clic.
//  2) iOS Safari → aucune API d'installation ; on guide vers Partager ⬆ → « Sur l'écran d'accueil ».
//
// Sur Android, rien : AndroidAppPrompt y propose l'appli Android (l'APK) à la place de la PWA.
// On y retient seulement la mini-barre d'installation de Chrome, qui proposerait la PWA.
//
// Jamais affichée si l'appli tourne déjà en standalone (déjà installée), et masquable
// (mémorisé en local : elle vit hors connexion, écran de login inclus).

import { useEffect, useState } from "react";
import { isAndroidApp } from "@/lib/androidApp";

const SNOOZE_KEY = "installPromptSnooze";
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // 14 jours

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Mode = "prompt" | "ios";

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
    // `isAndroidApp` : dans l'appli Android (TWA), proposer d'« installer l'appli » à
    // quelqu'un qui est dedans n'a pas de sens.
    if (isStandalone() || isAndroidApp() || snoozed()) return;

    // Le service worker n'était enregistré qu'à l'activation des notifications push. Or Chrome
    // conditionne `beforeinstallprompt` à un SW actif AVEC un handler `fetch` (ajouté dans
    // /public/sw.js) : on l'enregistre donc aussi ici, silencieusement (aucune permission).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* pas bloquant : sans SW actif, Chrome ne proposera pas l'installation automatique */
      });
    }

    // Chromium (desktop Chrome/Edge) : le vrai prompt d'installation, où elle a du sens
    // (raccourci appli). Sur Android, la mini-barre native est retenue et rien ne la remplace.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // on affiche NOTRE bannière plutôt que la mini-barre native
      if (isAndroid()) return;
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("prompt");
    };
    const onInstalled = () => {
      snooze();
      setMode(null);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Pas d'event possible sur iOS → instructions manuelles tout de suite.
    if (isIosSafari()) setMode("ios");

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

  // En mode `prompt`, toute la bannière est un déclencheur AU DOIGT ET À LA SOURIS : un tap
  // n'importe où (hors bouton « Plus tard ») ouvre DIRECTEMENT la popup native d'installation.
  // Note : cet appel doit venir d'un geste utilisateur — impossible de l'ouvrir automatiquement.
  //
  // ⚠️ PLUS DE `role="button"`, DE `tabIndex` NI DE `onKeyDown` SUR LE CONTENEUR. Le gestionnaire
  // de touche écoutait Entrée/Espace sur toute la bannière — donc aussi la touche REMONTÉE du
  // bouton « Plus tard » qui avait le focus : il appelait `preventDefault()`, ce qui annulait le
  // clic du bouton, puis lançait l'installation. Au clavier, « Plus tard » installait l'appli.
  // Un « bouton » qui contient deux boutons n'était pas non plus une structure lisible au lecteur
  // d'écran. Le clavier a déjà son chemin explicite : le bouton « Installer », juste à côté.
  const clickable = mode === "prompt";

  return (
    <div
      className={`install-banner${clickable ? " clickable" : ""}`}
      role="status"
      onClick={clickable ? install : undefined}
    >
      <img src="/logo_squash-96.webp" alt="" aria-hidden="true" className="install-banner-icon" />
      <span className="install-banner-text">
        {mode === "prompt" && (
          <>
            <strong>Installer l'appli Squash de l'Yvette</strong>
            <br />
            Ajoute-la à ton écran d'accueil : accès direct en un tap, affichage plein écran (sans
            la barre du navigateur) et alertes quand un terrain se libère. Rien à télécharger sur
            un store.
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
          // Bouton explicite en plus de la bannière cliquable (redondant mais rassurant).
          // stopPropagation : sinon le clic remonte au conteneur et appelle install() deux fois.
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              install();
            }}
          >
            Installer
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={(e) => {
            e.stopPropagation(); // ne pas déclencher l'installation via la bannière cliquable
            dismiss();
          }}
        >
          {mode === "prompt" ? "Plus tard" : "J'ai compris"}
        </button>
      </span>
    </div>
  );
}
