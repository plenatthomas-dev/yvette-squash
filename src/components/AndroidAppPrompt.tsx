"use client";

// Bannière « installer l'appli Android » : partout sur Android hors de l'appli elle-même, pour
// proposer l'appli Android (TWA, cf. android/README.md) publiée dans les Releases GitHub, à la
// place de la PWA. Ailleurs (iPhone, ordinateur), InstallAppPrompt s'en charge.
//
// Dans un onglet (typiquement arrivé par le QR code) :
//  1) lien de téléchargement ;
//  2) lien touché → comment installer le fichier.
// Dans la PWA déjà installée (une WebAPK), les mêmes, plus de quoi la supprimer ensuite ; et si
// l'appli est déjà installée (`getInstalledRelatedApps`), seulement cette suppression.
// Elle n'est pas un détail : Chrome confie les notifications d'un site à la WebAPK qui le
// couvre, et l'appli n'en recevrait aucune tant qu'elle reste là. Les deux ont le même nom et
// la même icône, d'où « l'icône qui a ouvert cette page ».
//
// Masquable 14 jours (mémorisé en local), comme InstallAppPrompt.

import { useEffect, useState } from "react";
import { androidAppInstalled, isAndroidApp, isAndroidPwa } from "@/lib/androidApp";

// La dernière Release GitHub, relayée par notre domaine (src/app/squash-yvette.apk/route.ts) : un
// lien github.com est réclamé par l'appli GitHub quand elle est installée, et le téléchargement
// reste alors bloqué dans sa fenêtre.
export const APK_URL = "/squash-yvette.apk";

const SNOOZE_KEY = "androidAppPromptSnooze";
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // 14 jours

type Mode = "offer" | "downloaded" | "installed";

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
    /* localStorage indisponible : la bannière reviendra au prochain lancement */
  }
}

export default function AndroidAppPrompt() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [pwa, setPwa] = useState(false);

  useEffect(() => {
    if (!/android/i.test(navigator.userAgent) || isAndroidApp() || snoozed()) return;
    const inPwa = isAndroidPwa();
    setPwa(inPwa);
    let cancelled = false;
    // Rien n'apparaît avant la réponse : sinon « Télécharger » clignoterait chez qui a l'appli.
    androidAppInstalled().then((installed) => {
      if (cancelled) return;
      // Dans un onglet, qui a déjà l'appli n'a rien à faire de plus.
      if (installed) setMode(inPwa ? "installed" : null);
      else setMode("offer");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!mode) return null;

  const dismiss = () => {
    snooze();
    setMode(null);
  };

  const removePwa = (
    <>
      appui long sur l'icône qui a ouvert cette page → <strong>Désinstaller</strong>. Sinon, c'est
      elle qui continue de recevoir les notifications.
    </>
  );

  return (
    <div className="install-banner" role="status">
      <img src="/logo_squash-96.webp" alt="" aria-hidden="true" className="install-banner-icon" />
      <span className="install-banner-text">
        {mode === "offer" && (
          <>
            <strong>L'appli Android du club est disponible</strong>
            <br />
            {pwa
              ? "Elle remplace cette version, ajoutée depuis le navigateur."
              : "Accès direct depuis l'écran d'accueil, plein écran et alertes quand un terrain se libère."}{" "}
            Elle s'installe depuis ce site, hors du Play Store.
          </>
        )}
        {mode === "downloaded" && (
          <>
            Ouvre <strong>squash-yvette.apk</strong> une fois téléchargé, puis accepte
            l'installation : Android demande d'abord d'autoriser le navigateur.
            {pwa && <> Ensuite, supprime cette version : {removePwa}</>}
          </>
        )}
        {mode === "installed" && (
          <>
            <strong>L'appli Android est installée</strong>
            <br />
            Tu peux supprimer cette version : {removePwa}
          </>
        )}
      </span>
      <span className="install-banner-actions">
        {mode === "offer" && (
          // Un lien plutôt qu'un bouton : le fichier arrive en pièce jointe, la page reste
          // affichée et passe aux instructions.
          <a role="button" href={APK_URL} download onClick={() => setMode("downloaded")}>
            Télécharger
          </a>
        )}
        <button type="button" className="secondary" onClick={dismiss}>
          {mode === "offer" ? "Plus tard" : "J'ai compris"}
        </button>
      </span>
    </div>
  );
}
