"use client";

// Modale d'annonce : quand on clique sur la notification push « annonce à tous » (envoyée
// depuis /admin), l'appli s'ouvre sur /?announce=1&t=…&b=… et ce composant ré-affiche le
// message dans une boîte, refermable (croix, bouton, ou clic sur le fond). Stateless : tout
// est porté par l'URL, rien à charger. Nettoie l'URL à la fermeture (pas de ré-affichage au refresh).

import { useEffect, useState } from "react";

export default function AnnounceModal() {
  const [ann, setAnn] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("announce") !== "1") return;
    const title = (p.get("t") ?? "").trim();
    const body = (p.get("b") ?? "").trim();
    if (!title && !body) return;
    setAnn({ title, body });
  }, []);

  const close = () => {
    setAnn(null);
    const u = new URL(window.location.href);
    for (const k of ["announce", "t", "b"]) u.searchParams.delete(k);
    window.history.replaceState({}, "", u.pathname + u.search + u.hash);
  };

  if (!ann) return null;

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Annonce"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>📣 {ann.title || "Annonce"}</h3>
          <button
            type="button"
            onClick={close}
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
        {ann.body && (
          <p style={{ margin: "0 0 18px", whiteSpace: "pre-wrap", color: "var(--pico-color)" }}>
            {ann.body}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
