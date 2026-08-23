"use client";

// Rechargement automatique quand un onglet resté ouvert depuis AVANT un déploiement tente de
// charger un morceau JS (lazy-load — ex. la vue Tricount, chargée via next/dynamic) qui n'existe
// plus dans le nouveau build : Next.js le sert par son ancien nom hashé, or seuls les fichiers du
// déploiement COURANT restent servis derrière l'alias de branche → 404, `ChunkLoadError`.
// Complète UpdateReloader (qui, lui, recharge AVANT que ça casse) : ce composant-ci
// couvre le cas où l'erreur survient quand même, en rechargeant tout seul plutôt que de laisser
// planter l'appli (cf. incident du 2026-08-23 sur la recette).
//
// Aucun rendu : uniquement des écouteurs globaux, posés une fois dans le layout.

import { useEffect } from "react";

const CHUNK_ERROR_RE = /ChunkLoadError|Loading chunk [\w-]+ failed/i;
// Garde-fou anti-boucle : si le rechargement ne règle rien (ex. réseau coupé), on ne
// re-déclenche pas en rafale — une nouvelle tentative toutes les 30 s au plus.
const COOLDOWN_KEY = "chunkReloadAt";
const COOLDOWN_MS = 30_000;

function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(COOLDOWN_KEY) ?? 0);
    if (Date.now() - last < COOLDOWN_MS) return;
    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
  } catch {
    /* sessionStorage indisponible : on tente quand même, au pire une boucle rare */
  }
  window.location.reload();
}

export default function ChunkErrorReload() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (CHUNK_ERROR_RE.test(e.message ?? "") || e.error?.name === "ChunkLoadError") {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg = typeof reason === "string" ? reason : (reason?.message ?? "");
      if (CHUNK_ERROR_RE.test(msg) || reason?.name === "ChunkLoadError") {
        reloadOnce();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
