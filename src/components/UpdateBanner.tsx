"use client";

// Bannière « nouvelle version disponible » : détecte un onglet resté ouvert depuis AVANT un
// déploiement (le JS chargé est alors l'ANCIEN, alors que les API routes tournent déjà sur le
// NOUVEAU code) — cas vécu le 2026-08-23 sur la recette : un onglet périmé a fini par planter
// (TypeError) au lieu de simplement proposer un rechargement. Complète ChunkErrorReload, qui
// lui gère le cas où l'ancien JS tente de charger un morceau qui n'existe plus.
//
// Détection : comparaison du build id EMBARQUÉ dans le JS courant (NEXT_PUBLIC_BUILD_ID, figé
// à la compilation — cf. next.config.mjs) à celui que renvoie /api/version, qui lui reflète
// TOUJOURS le déploiement actuellement en ligne.
//
// Que fait-on de l'écart ? On RECHARGE TOUT SEUL quand c'est sans risque, on propose sinon.
// Le cas courant sur téléphone — rouvrir la PWA après des heures, sans rien avoir saisi —
// tombe dans « sans risque » : la mise à jour est alors invisible, aucun geste demandé. Mais
// recharger inconditionnellement effacerait une dépense à moitié saisie, un commentaire en
// cours ou un mot de passe tapé : dans ces cas-là seulement, on affiche la bannière et c'est
// l'utilisateur qui choisit le moment. Cf. `isSafeToReload`.

import { useCallback, useEffect, useRef, useState } from "react";
import { isSafeToReload } from "@/lib/update-reload";

// Cadence de re-sondage tant que l'onglet reste ouvert (en plus du focus/visibilitychange).
// Peu fréquent : un déploiement n'arrive pas toutes les minutes, inutile de solliciter la route.
const POLL_MS = 10 * 60_000;

// Garde-fou anti-boucle, partagé avec ChunkErrorReload : si un rechargement ne suffit pas à
// aligner les versions (HTML servi depuis un cache intermédiaire, déploiement en cours de
// bascule…), on ne recharge pas en rafale — la bannière prend alors le relais.
const COOLDOWN_KEY = "chunkReloadAt";
const COOLDOWN_MS = 30_000;

// Fréquence de re-test de « peut-on recharger maintenant ? » une fois l'écart de version
// connu. Court : dès que l'utilisateur repose son formulaire, la mise à jour se fait.
const SAFE_RECHECK_MS = 3_000;

/**
 * Traduit les champs de la page en descripteurs, et délègue la DÉCISION à `isSafeToReload`
 * (lib/update-reload, testée à part). Ici, uniquement de la lecture de DOM.
 */
function canReloadNow(): boolean {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  )].map((f) => ({
    type: f instanceof HTMLInputElement ? f.type : "textarea",
    value: f.value,
    // `offsetParent === null` couvre display:none et les ancêtres masqués ; `hidden`/aria-hidden
    // couvrent le champ rendu hors écran mais techniquement « affiché », comme le datepicker.
    visible: f.offsetParent !== null && !f.hidden && f.getAttribute("aria-hidden") !== "true",
  }));
  return isSafeToReload(document.querySelector("dialog[open]") !== null, fields);
}

export default function UpdateBanner() {
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  // Version pour laquelle l'utilisateur a déjà fermé la bannière — on ne la ré-affiche pas
  // pour ce même build (mais un déploiement SUIVANT, lui, la fait réapparaître). Vrai state
  // et non une ref : la fermeture doit provoquer un re-render pour masquer la bannière.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const lastFetchRef = useRef(0);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { buildId: string | null };
      if (data.buildId) setServerBuildId(data.buildId);
    } catch {
      /* réseau indisponible : on retentera au prochain déclencheur, sans bruit */
    }
  }, []);

  useEffect(() => {
    check();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFetchRef.current < 15000) return;
      lastFetchRef.current = now;
      check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const id = window.setInterval(check, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(id);
    };
  }, [check]);

  const myBuildId = process.env.NEXT_PUBLIC_BUILD_ID ?? null;
  const stale =
    myBuildId !== null && serverBuildId !== null && serverBuildId !== myBuildId;

  // Version périmée ET rien à perdre à l'écran : on recharge sans rien demander.
  // La condition est re-testée périodiquement, et PAS seulement au moment où l'écart est
  // découvert : la saisie qui bloque le rechargement vit dans d'AUTRES composants (formulaire
  // de dépense, connexion…), dont les changements ne provoquent aucun render ici. Sans ce
  // re-test, refermer sa modale ou vider son champ ne débloquait jamais rien.
  useEffect(() => {
    if (!stale || dismissedFor === serverBuildId) return;
    const tryReload = () => {
      if (!canReloadNow()) return;
      try {
        const last = Number(sessionStorage.getItem(COOLDOWN_KEY) ?? 0);
        if (Date.now() - last < COOLDOWN_MS) return; // déjà tenté : la bannière prend le relais
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      } catch {
        /* sessionStorage indisponible : on recharge quand même, le cas est rare */
      }
      window.location.reload();
    };
    tryReload();
    const id = window.setInterval(tryReload, SAFE_RECHECK_MS);
    return () => window.clearInterval(id);
  }, [stale, dismissedFor, serverBuildId]);

  // Reste la bannière : uniquement quand le rechargement automatique n'a PAS pu se faire
  // (saisie en cours, ou garde-fou anti-boucle), et tant que l'utilisateur ne l'a pas fermée.
  if (!stale || dismissedFor === serverBuildId) return null;

  return (
    <div
      role="status"
      style={{
        // Le bleu « info » DÉJÀ employé par AnnouncementBanner, et non une teinte à soi :
        // DESIGN.md ne reconnaît qu'un accent (le vert, réservé à ce qui est actionnable),
        // et les bandeaux de layout partagent un petit vocabulaire — bleu = information,
        // orange = avertissement, rouge = incident. Une mise à jour disponible est une info.
        background: "#2563eb",
        color: "#ffffff",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: "0.95rem",
        fontWeight: 600,
        lineHeight: 1.4,
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      <span aria-hidden style={{ fontSize: "1.15rem" }}>
        🔄
      </span>
      <span>Une nouvelle version de l&apos;appli est disponible.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          background: "#ffffff",
          color: "#2563eb",
          border: "none",
          borderRadius: 6,
          padding: "4px 12px",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Recharger
      </button>
      <button
        type="button"
        onClick={() => setDismissedFor(serverBuildId)}
        aria-label="Masquer"
        style={{
          background: "transparent",
          border: "none",
          color: "#ffffff",
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
  );
}
