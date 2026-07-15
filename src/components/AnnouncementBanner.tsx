"use client";

// Bannière d'annonce (étape 2 de l'admin) : message éditable par un admin, affiché en haut de
// l'appli pour TOUS (complément non-intrusif de la notification push). Masquable ; une bannière
// MODIFIÉE (nouvelle `version`) repasse devant les yeux même si l'ancienne avait été fermée.

import { useEffect, useState } from "react";

type Banner = { message: string; level: "info" | "warn"; version: string };

const DISMISS_KEY = "bannerDismissed"; // version de la dernière bannière masquée

const palette = {
  info: { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e3a8a" },
  warn: { bg: "#fef3c7", border: "#fcd34d", fg: "#92400e" },
} as const;

export default function AnnouncementBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/banner");
        if (!res.ok) return;
        const data = (await res.json()) as { banner: Banner | null };
        if (!data.banner) return;
        // Déjà masquée dans cette même version ? On n'affiche pas.
        if (localStorage.getItem(DISMISS_KEY) === data.banner.version) return;
        setBanner(data.banner);
      } catch {
        /* réseau indisponible : pas de bannière, sans bruit */
      }
    })();
  }, []);

  if (!banner) return null;
  const c = palette[banner.level];

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, banner.version);
    } catch {
      /* localStorage indisponible : on masque quand même pour cette session */
    }
    setBanner(null);
  };

  return (
    <div
      role="status"
      style={{
        background: c.bg,
        color: c.fg,
        borderBottom: `1px solid ${c.border}`,
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: "0.9rem",
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{banner.message}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Masquer l'annonce"
        style={{
          background: "transparent",
          border: "none",
          color: c.fg,
          cursor: "pointer",
          padding: 0,
          margin: 0,
          width: "auto",
          fontSize: "1.1rem",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}
