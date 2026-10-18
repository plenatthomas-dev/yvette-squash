"use client";

// Le bouton « Paramètres » de l'en-tête. Le PANNEAU qu'il ouvre (`SettingsPanel`) est chargé à
// la demande, au premier clic : c'est le plus lourd des modules de l'écran d'accueil, et la
// plupart des visites n'y touchent pas (audit 2026-10, point 27).

import { useState } from "react";
import dynamic from "next/dynamic";
import type { SettingsProps } from "./SettingsPanel";

const SettingsPanel = dynamic(() => import("./SettingsPanel"), { ssr: false });

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function SettingsButton(props: SettingsProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="secondary icon-btn"
        onClick={() => setOpen(true)}
        aria-label="Paramètres"
        title="Paramètres"
      >
        <GearIcon />
      </button>
      {open && <SettingsPanel {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
