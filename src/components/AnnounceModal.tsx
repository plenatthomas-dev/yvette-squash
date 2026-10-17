"use client";

// Modale d'annonce : quand on clique sur la notification push « annonce à tous » (envoyée
// depuis /admin), l'appli s'ouvre sur /?announce=<id> et ce composant relit le message CHEZ LE
// SERVEUR, puis l'affiche dans une boîte refermable (croix, bouton, ou clic sur le fond).
// Nettoie l'URL à la fermeture (pas de ré-affichage au refresh).
//
// L'URL portait autrefois le titre et le texte (`t`, `b`), affichés tels quels sous l'en-tête
// officiel : n'importe qui pouvait fabriquer un lien vers un faux message du club (audit
// 2026-10, point 25). Ces paramètres sont désormais ignorés.

import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";

export default function AnnounceModal() {
  const [ann, setAnn] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("announce");
    if (!id || id === "1") return;
    let vivant = true;
    fetch(`/api/announce?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ title?: string; body?: string }>) : null))
      .then((a) => {
        if (vivant && a && (a.title || a.body)) setAnn({ title: a.title ?? "", body: a.body ?? "" });
      })
      .catch(() => {});
    return () => {
      vivant = false;
    };
  }, []);

  const close = () => {
    setAnn(null);
    const u = new URL(window.location.href);
    for (const k of ["announce", "t", "b"]) u.searchParams.delete(k);
    window.history.replaceState({}, "", u.pathname + u.search + u.hash);
  };

  if (!ann) return null;

  // <Dialog> et pas un overlay écrit à la main : cette modale s'ouvre AUTOMATIQUEMENT au
  // chargement (clic sur une notification push). Elle annonçait aria-modal="true" sans
  // gestionnaire de touche — donc sans Échap ni piège de focus : au clavier on en sortait
  // par Tab pour interagir avec une page qu'on croit bloquée. Un rôle ARIA qui ment est
  // pire que pas de rôle ; useDialog tient désormais la promesse.
  return (
    <Dialog onClose={close} label="Annonce">
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
    </Dialog>
  );
}
