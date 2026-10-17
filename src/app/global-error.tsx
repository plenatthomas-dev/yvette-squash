"use client";

// Dernier filet : une erreur dans le LAYOUT lui-même. Il remplace tout le document, d'où le
// <html>/<body> et l'absence de la feuille Pico — styles en ligne, sobres, lisibles en clair
// comme en sombre.

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <html lang="fr">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          maxWidth: 480,
          margin: "48px auto",
          padding: "0 16px",
          lineHeight: 1.5,
          colorScheme: "light dark",
        }}
      >
        <h1 style={{ fontSize: "1.4rem" }}>L&apos;appli n&apos;a pas pu s&apos;afficher</h1>
        <p>L&apos;erreur a été signalée aux responsables du club. Recharge la page pour réessayer.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: "10px 18px", fontSize: "1rem", cursor: "pointer" }}
        >
          Recharger
        </button>
        {error.digest && (
          <p style={{ fontSize: 13, opacity: 0.7, marginTop: 16 }}>Référence : {error.digest}</p>
        )}
      </body>
    </html>
  );
}
