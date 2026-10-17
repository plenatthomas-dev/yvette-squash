"use client";

// Écran d'erreur d'une page (audit 2026-10, point 10). Sans lui, Next affichait sa page
// générique en anglais — « Application error: a client-side exception has occurred » — et
// l'erreur ne laissait aucune trace au-delà de l'heure de logs du plan Hobby.

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <main className="container" style={{ maxWidth: 480, paddingTop: 48 }}>
      <h1 style={{ fontSize: "1.4rem" }}>Oups, quelque chose a cassé</h1>
      <p>
        L&apos;erreur a été signalée aux responsables du club. Réessaie : la plupart du temps, ça
        repart tout seul.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => reset()}>
          Réessayer
        </button>
        <button type="button" className="secondary" onClick={() => window.location.assign("/")}>
          Revenir à l&apos;accueil
        </button>
      </div>
      {error.digest && (
        <p className="muted tiny" style={{ marginTop: 16 }}>
          Référence : <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}
