"use client";

// Bannière d'annonce (étape 2 de l'admin) : message éditable par un admin, affiché à TOUS.
// Rendu « bien visible » (choix UX « les deux ») :
//  1) une MODALE la première fois qu'on voit une annonce donnée (impossible à rater) ;
//  2) puis une BANNIÈRE pleine couleur en haut, tant que l'annonce est active.
// Les deux se pilotent depuis un seul fetch et se ferment indépendamment. Une annonce MODIFIÉE
// (nouvelle `version`) repasse devant les yeux (modale + bannière ré-affichées).

import { useEffect, useRef, useState } from "react";

type Banner = { message: string; level: "info" | "warn"; version: string };

const DISMISS_KEY = "bannerDismissed"; // version de la bannière masquée (croix)
const MODAL_SEEN_KEY = "bannerModalSeen"; // version dont la modale a déjà été vue

// Couleurs pleines et saturées (texte blanc) pour bien trancher avec l'appli.
const palette = {
  info: { bg: "#2563eb", fg: "#ffffff" },
  warn: { bg: "#ea580c", fg: "#ffffff" },
} as const;

export default function AnnouncementBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showModal, setShowModal] = useState(false);
  // Défilement (marquee) du message quand il dépasse la largeur du bandeau.
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(false);
  const [durationS, setDurationS] = useState(16);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/banner");
        if (!res.ok) return;
        const data = (await res.json()) as { banner: Banner | null };
        const b = data.banner;
        if (!b) return;
        setBanner(b);
        // Bannière : visible sauf si masquée dans cette version.
        setShowBanner(localStorage.getItem(DISMISS_KEY) !== b.version);
        // Modale : une seule fois par version.
        setShowModal(localStorage.getItem(MODAL_SEEN_KEY) !== b.version);
      } catch {
        /* réseau indisponible : pas d'annonce, sans bruit */
      }
    })();
  }, []);

  // Active le défilement seulement si le texte déborde ; vitesse constante (durée ∝ distance).
  useEffect(() => {
    if (!showBanner || !banner) return;
    const measure = () => {
      const box = boxRef.current;
      const txt = textRef.current;
      if (!box || !txt) return;
      const overflow = txt.scrollWidth > box.clientWidth + 2;
      setScroll(overflow);
      if (overflow) setDurationS(Math.max(10, (2 * txt.scrollWidth) / 80)); // ~80 px/s
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [showBanner, banner]);

  if (!banner) return null;
  const c = palette[banner.level];

  const closeModal = () => {
    try {
      localStorage.setItem(MODAL_SEEN_KEY, banner.version);
    } catch {
      /* localStorage indisponible : on masque au moins pour la session */
    }
    setShowModal(false);
  };

  const dismissBanner = () => {
    try {
      localStorage.setItem(DISMISS_KEY, banner.version);
    } catch {
      /* idem */
    }
    setShowBanner(false);
  };

  return (
    <>
      {/* Bannière pleine couleur, en haut de l'appli. */}
      {showBanner && (
        <div
          role="status"
          style={{
            background: c.bg,
            color: c.fg,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: "0.95rem",
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          <span aria-hidden style={{ fontSize: "1.15rem" }}>
            📣
          </span>
          <div
            ref={boxRef}
            style={{ flex: 1, overflow: "hidden", textAlign: scroll ? "left" : "center" }}
          >
            <span
              ref={textRef}
              className={scroll ? "announce-marquee" : undefined}
              style={{
                display: "inline-block",
                whiteSpace: "nowrap",
                ...(scroll ? { animationDuration: `${durationS}s` } : null),
              }}
            >
              {banner.message}
            </span>
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Masquer l'annonce"
            style={{
              background: "transparent",
              border: "none",
              color: c.fg,
              cursor: "pointer",
              padding: 0,
              margin: 0,
              width: "auto",
              fontSize: "1.15rem",
              lineHeight: 1,
              opacity: 0.9,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Modale la première fois qu'on voit cette annonce. */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Annonce"
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>📣 Annonce</h3>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Fermer"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  margin: 0,
                  width: "auto",
                  fontSize: "1.3rem",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <p style={{ margin: "0 0 18px", whiteSpace: "pre-wrap", color: "var(--pico-color)" }}>
              {banner.message}
            </p>
            <div className="modal-actions">
              <button type="button" onClick={closeModal}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
