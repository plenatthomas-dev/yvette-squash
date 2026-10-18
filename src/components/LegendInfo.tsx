"use client";

// Légende des couleurs (extraite de page.tsx), repliée dans un petit popover ⓘ pour
// libérer une ligne à l'écran. Réutilise l'icône InfoIcon de la note de confidentialité.

import { useEffect, useRef, useState } from "react";
import { InfoIcon } from "@/components/PrivacyNotice";
import { useCloseRequest } from "@/lib/useCloseRequest";

export function LegendInfo() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Le retour d'Android referme la légende plutôt que l'appli.
  useCloseRequest(() => setOpen(false), open);

  // `role="dialog"` promet une fermeture au clavier ; sans elle, un utilisateur au clavier
  // n'avait aucune sortie documentée (le seul chemin était de CLIQUER le fond). Un rôle ARIA
  // qui ment est pire que pas de rôle. Le focus revient sur le déclencheur à la fermeture,
  // sinon il repart au début du document.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  return (
    <span className="legend-info">
      <button
        ref={btnRef}
        type="button"
        className="secondary icon-btn"
        aria-label="Légende des couleurs"
        aria-expanded={open}
        title="Légende"
        onClick={() => setOpen((o) => !o)}
      >
        <InfoIcon />
      </button>
      {open && (
        <>
          <div className="legend-backdrop" onClick={() => setOpen(false)} />
          <div className="legend-pop" role="dialog" aria-label="Légende des couleurs">
            {/* Les pastilles reprennent les MOTIFS de la vue semaine (`.wk-chip`), pas seulement
                la couleur : c'est la légende qui apprend à les lire (audit 2026-10, point 29). */}
            <span><i className="wk-chip free" /> Libre</span>
            <span><i className="wk-chip asso" /> Réservé (asso) · points</span>
            <span><i className="wk-chip other" /> Réservé (autre) · hachures</span>
            <span><i className="wk-chip mine" /> Ta réservation · ★</span>
          </div>
        </>
      )}
    </span>
  );
}
