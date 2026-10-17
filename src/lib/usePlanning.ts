"use client";

// LE PLANNING DE L'ÉCRAN D'ACCUEIL : jour ou semaine, journal du groupe, compteurs de liste
// d'attente — l'état et ses chargeurs, sortis de HomeApp (audit 2026-10, point 28 : la page
// tenait 43 `useState` et 1 900 lignes).
//
// Ce que le hook garantit, et qui vivait jusque-là au milieu de la page : une réponse arrivée
// en retard (un autre jour, une autre vue demandée entre-temps) n'écrase jamais l'état — chaque
// chargement prend un numéro (`planningRequest`), et seul le dernier écrit.

import { useCallback, useRef, useState } from "react";
import type { PlanningDay } from "@/lib/resamania/types";
import { ApiError, callApi, userMessage } from "@/lib/apiFetch";
import type { View } from "@/lib/views";

export interface JournalEntry {
  id: string;
  displayName: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  mine: boolean;
  // "app" = réservé depuis l'appli ; "resamania" = réservé directement sur ResaMania et
  // détecté par la réconciliation du planning. Absent des réponses d'avant cette fonction
  // (et des serveurs où le flag `externalBookings` est coupé) ⇒ traité comme "app".
  source?: "app" | "resamania";
  // Non null si je peux annuler cette résa au nom d'un délégant (= son userId à passer en
  // onBehalfOf). Permet à un délégataire — dont un compte « email seul » — de gérer la résa.
  manageableOnBehalfOf?: string | null;
}

export function usePlanning(date: string, view: View, onUnauthorized: () => void) {
  const [planning, setPlanning] = useState<PlanningDay | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [week, setWeek] = useState<{ date: string; planning: PlanningDay }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [waitCounts, setWaitCounts] = useState<Record<string, number>>({});
  // Le rappel de session expirée change d'identité à chaque rendu chez l'appelant : on le lit
  // par référence pour que `load`/`loadWeek` restent stables.
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  // Compteurs « N en attente » pour la plage [from, to] (jour : from==to).
  const planningRequest = useRef(0);
  const invalidatePlanningRequest = useCallback(() => { planningRequest.current++; }, []);
  const planningContext = useRef({ date, view });
  planningContext.current = { date, view };
  const loadWaitCounts = useCallback(async (from: string, to: string, request = planningRequest.current) => {
    const r = await fetch(`/api/alerts/counts?from=${from}&to=${to}`);
    const counts = r.ok ? await r.json() : {};
    if (request === planningRequest.current) setWaitCounts(counts);
  }, []);

  const load = useCallback(
    // `fresh` : on vient de réserver ou d'annuler et on attend de VOIR le résultat. Le cache
    // planning vit en mémoire de process : l'invalidation faite par la route d'écriture ne
    // vaut que pour SON instance serverless, et ce GET peut tomber ailleurs (cf. getPlanning).
    async (d: string, fresh = false) => {
      if (planningContext.current.date !== d || planningContext.current.view !== "day") return;
      const request = ++planningRequest.current;
      setLoading(true);
      setError(null);
      try {
        // Séquentiel à dessein : /api/planning réconcilie la base (résas annulées ailleurs),
        // puis /api/bookings lit un journal déjà à jour.
        //
        // `callApi` et non `fetch` + `res.json()` : ce couple affichait « Failed to fetch » hors
        // réseau et « Unexpected end of JSON input » sur un 500 au corps vide, en lieu et place
        // de la grille (cf. lib/apiFetch). Le 401 arrive désormais par l'exception, avec son
        // statut — d'où son traitement dans le `catch`, APRÈS le contrôle de péremption.
        const pdata = await callApi<PlanningDay>(`/api/planning?date=${d}${fresh ? "&fresh=1" : ""}`);
        if (request !== planningRequest.current) return;
        setPlanning(pdata);
        // Le journal est un COMPLÉMENT de la grille : son échec (réseau perdu entre les deux
        // appels) ne doit pas effacer un planning qu'on vient d'obtenir. Il l'effaçait — un
        // TypeError ici tombait dans le `catch` ci-dessous, qui remet le planning à `null`.
        const journal = await fetch(`/api/bookings?date=${d}`)
          .then((jr) => (jr.ok ? jr.json() : []))
          .catch(() => []);
        if (request !== planningRequest.current) return;
        setJournal(journal);
        void loadWaitCounts(d, d, request).catch(() => {});
      } catch (e) {
        if (request !== planningRequest.current) return;
        if (e instanceof ApiError && e.status === 401) {
          unauthorized.current();
          return;
        }
        setError(userMessage(e));
        setPlanning(null);
      } finally {
        if (request === planningRequest.current) setLoading(false);
      }
    },
    [loadWaitCounts],
  );

  const loadWeek = useCallback(async (d: string, fresh = false) => {
    if (planningContext.current.date !== d || planningContext.current.view !== "week") return;
    const request = ++planningRequest.current;
    setLoading(true);
    setError(null);
    try {
      // Un seul appel : /api/week renvoie les 7 jours (planning brut, sans réconciliation).
      // `callApi` : même raison que pour le jour (cf. `load`), même traitement du 401.
      const wk = await callApi<{ date: string; planning: PlanningDay }[]>(
        `/api/week?date=${d}${fresh ? "&fresh=1" : ""}`,
      );
      if (request !== planningRequest.current) return;
      setWeek(wk);
      if (wk.length) void loadWaitCounts(wk[0].date, wk[wk.length - 1].date, request).catch(() => {});
    } catch (e) {
      if (request !== planningRequest.current) return;
      if (e instanceof ApiError && e.status === 401) {
        unauthorized.current();
        return;
      }
      setError(userMessage(e));
      setWeek([]);
    } finally {
      if (request === planningRequest.current) setLoading(false);
    }
  }, [loadWaitCounts]);

  return {
    planning,
    setPlanning,
    journal,
    setJournal,
    week,
    setWeek,
    error,
    setError,
    loading,
    waitCounts,
    planningRequest,
    invalidatePlanningRequest,
    loadWaitCounts,
    load,
    loadWeek,
  };
}
