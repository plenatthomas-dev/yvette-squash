"use client";

// Légende des couleurs (extraite de page.tsx), repliée dans un petit popover ⓘ pour
// libérer une ligne à l'écran. Réutilise l'icône InfoIcon de la note de confidentialité.

import { useState } from "react";
import { InfoIcon } from "@/components/PrivacyNotice";

export function LegendInfo() {
  const [open, setOpen] = useState(false);
  return (
    <span className="legend-info">
      <button
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
            <span><i style={{ background: "var(--free)" }} /> Libre</span>
            <span><i style={{ background: "var(--group)" }} /> Réservé (asso)</span>
            <span><i style={{ background: "var(--booked)" }} /> Réservé (autre)</span>
          </div>
        </>
      )}
    </span>
  );
}
