"use client";

// Le guide affiché quand les notifications sont REFUSÉES sur cet appareil : le chemin exact
// pour les rétablir (cf. `notif-unblock.ts`), et un bouton pour vérifier tout de suite. Le
// retour dans l'appli est de toute façon surveillé par l'écran qui l'affiche : le bouton est
// un filet, pas un passage obligé.

import { useEffect, useState, type ReactNode } from "react";
import { currentNotifPlatform, unblockGuide, type UnblockGuide } from "@/lib/notif-unblock";
import { markPushWanted } from "@/lib/pushClient";

export default function NotifUnblockHelp({
  intro,
  onRecheck,
  busy = false,
}: {
  intro: ReactNode;
  onRecheck: () => void;
  busy?: boolean;
}) {
  // Lu après le montage : l'agent utilisateur n'existe pas au rendu serveur.
  const [guide, setGuide] = useState<UnblockGuide | null>(null);

  useEffect(() => {
    setGuide(unblockGuide(currentNotifPlatform(), window.location.host));
    markPushWanted();
  }, []);

  return (
    <div className="notif-unblock">
      <p>{intro}</p>
      {guide && (
        <>
          <ol className="notif-unblock-steps">
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {guide.hints?.map((h) => (
            <p key={h} className="muted">
              {h}
            </p>
          ))}
        </>
      )}
      <button type="button" className="secondary notif-unblock-check" disabled={busy} onClick={onRecheck}>
        {busy ? "…" : "C'est fait, vérifier"}
      </button>
    </div>
  );
}
