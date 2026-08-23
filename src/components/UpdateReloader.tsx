"use client";

// Mise à jour SILENCIEUSE d'un onglet resté ouvert depuis avant un déploiement. Un tel onglet
// (ou une PWA installée sur un téléphone) continue de tourner avec l'ANCIEN JS pendant que les
// API servent déjà le NOUVEAU code : il finit par planter, comme sur la recette le 2026-08-23.
// Complète ChunkErrorReload, qui lui rattrape le cas où l'ancien JS demande un morceau
// désormais absent du build.
//
// Détection : comparaison du build id EMBARQUÉ dans le JS courant (NEXT_PUBLIC_BUILD_ID, figé
// à la compilation — cf. next.config.mjs) à celui que renvoie /api/version, qui reflète TOUJOURS
// le déploiement en ligne.
//
// Ce composant N'AFFICHE RIEN, jamais : pas de bandeau, pas de bouton « recharger ». Choix
// assumé — on ne demande pas à l'utilisateur de gérer une histoire de version, on met à jour
// pour lui. Il ne recharge donc QUE lorsque c'est sans danger (rien de saisi, aucune modale
// ouverte, cf. lib/update-reload) ; sinon il patiente et re-teste, si bien qu'une dépense à
// moitié remplie ou un mot de passe tapé ne sont jamais effacés. Tant que la saisie dure, on
// ne fait rien du tout — la mise à jour se fera dès qu'elle sera terminée.

import { useCallback, useEffect, useRef, useState } from "react";
import { isSafeToReload } from "@/lib/update-reload";

// Cadence de re-sondage tant que l'onglet reste ouvert (en plus du focus/visibilitychange).
// Peu fréquent : un déploiement n'arrive pas toutes les minutes, inutile de solliciter la route.
const POLL_MS = 10 * 60_000;

// Garde-fou anti-boucle, partagé avec ChunkErrorReload : si un rechargement ne suffit pas à
// aligner les versions (HTML servi depuis un cache intermédiaire, déploiement en cours de
// bascule…), on ne recharge pas en rafale.
const COOLDOWN_KEY = "chunkReloadAt";
const COOLDOWN_MS = 30_000;

// Fréquence de re-test de « peut-on recharger maintenant ? » une fois l'écart de version connu.
// Court : dès que l'utilisateur repose son formulaire, la mise à jour se fait.
const SAFE_RECHECK_MS = 3_000;

/**
 * Traduit les champs de la page en descripteurs, et délègue la DÉCISION à `isSafeToReload`
 * (lib/update-reload, testée à part). Ici, uniquement de la lecture de DOM.
 */
function canReloadNow(): boolean {
  const fields = [
    ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
  ].map((f) => ({
    type: f instanceof HTMLInputElement ? f.type : "textarea",
    value: f.value,
    // `offsetParent === null` couvre display:none et les ancêtres masqués ; `hidden`/aria-hidden
    // couvrent le champ rendu hors écran mais techniquement « affiché », comme le datepicker.
    visible: f.offsetParent !== null && !f.hidden && f.getAttribute("aria-hidden") !== "true",
  }));
  return isSafeToReload(document.querySelector("dialog[open]") !== null, fields);
}

export default function UpdateReloader() {
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
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
  const stale = myBuildId !== null && serverBuildId !== null && serverBuildId !== myBuildId;

  // Version périmée : on recharge dès que c'est sans danger. La condition est re-testée
  // périodiquement, et PAS seulement au moment où l'écart est découvert : la saisie qui
  // bloque le rechargement vit dans d'AUTRES composants (formulaire de dépense, connexion…),
  // dont les changements ne provoquent aucun render ici. Sans ce re-test, refermer sa modale
  // ou vider son champ ne débloquerait jamais rien.
  useEffect(() => {
    if (!stale) return;
    const tryReload = () => {
      if (!canReloadNow()) return;
      try {
        const last = Number(sessionStorage.getItem(COOLDOWN_KEY) ?? 0);
        if (Date.now() - last < COOLDOWN_MS) return;
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      } catch {
        /* sessionStorage indisponible : on recharge quand même, le cas est rare */
      }
      window.location.reload();
    };
    tryReload();
    const id = window.setInterval(tryReload, SAFE_RECHECK_MS);
    return () => window.clearInterval(id);
  }, [stale]);

  return null;
}
