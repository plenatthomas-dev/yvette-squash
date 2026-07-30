"use client";

// Bannière « Appli en maintenance » : s'affiche quand la base de données (Neon) est injoignable
// — compute mis en veille au-delà du quota du plan Free, coupure, etc. Elle remplace, côté
// utilisateur, le message technique « Unexpected end of JSON input » qu'on voyait au login quand
// une route jetait avant de pouvoir répondre en JSON (cf. lib/apiFetch).
//
// Déclenchée par `reportMaintenance()` dès qu'un appel échoue faute de base. Tant qu'elle est
// visible, elle re-sonde /api/health périodiquement et disparaît d'elle-même dès que la base
// répond de nouveau. Elle vit dans le LAYOUT (tout en haut), donc visible aussi bien sur l'écran
// de connexion que dans l'appli.

import { useCallback, useEffect, useRef, useState } from "react";
import { MAINTENANCE_EVENT, isDbDown } from "@/lib/apiFetch";

// Cadence de re-sondage tant que la base est à terre. Volontairement peu fréquent : une base en
// veille par quota ne « rouvre » pas avant le reset mensuel, inutile de la marteler.
const POLL_MS = 20_000;

export default function MaintenanceBanner() {
  const [down, setDown] = useState(false);
  // Évite les sondages concurrents (plusieurs signaux rapprochés, ou signal pendant un poll).
  const probing = useRef(false);

  const check = useCallback(async () => {
    if (probing.current) return;
    probing.current = true;
    try {
      setDown(await isDbDown());
    } finally {
      probing.current = false;
    }
  }, []);

  // Signal `reportMaintenance()` : si l'émetteur a déjà confirmé via /api/health, on affiche tout
  // de suite ; sinon on confirme d'abord (pas de faux positif sur un incident non lié à la base).
  useEffect(() => {
    const onSignal = (e: Event) => {
      if ((e as CustomEvent<{ confirmed?: boolean }>).detail?.confirmed) setDown(true);
      else check();
    };
    window.addEventListener(MAINTENANCE_EVENT, onSignal);
    return () => window.removeEventListener(MAINTENANCE_EVENT, onSignal);
  }, [check]);

  // Tant que c'est à terre : on re-sonde périodiquement et on se masque dès le retour de la base.
  useEffect(() => {
    if (!down) return;
    const id = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(id);
  }, [down, check]);

  if (!down) return null;

  return (
    <div
      role="alert"
      style={{
        background: "#dc2626",
        color: "#ffffff",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: "0.95rem",
        fontWeight: 600,
        lineHeight: 1.4,
        textAlign: "center",
        justifyContent: "center",
      }}
    >
      <span aria-hidden style={{ fontSize: "1.15rem" }}>
        🛠️
      </span>
      <span>
        <strong>Appli en maintenance</strong> — la base de données est momentanément indisponible.
        Réessaie dans quelques minutes.
      </span>
    </div>
  );
}
