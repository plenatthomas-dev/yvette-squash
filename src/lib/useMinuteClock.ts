"use client";

import { useEffect, useState } from "react";

/**
 * L'heure courante, rafraîchie toutes les 30 s TANT QUE `active` — pour faire avancer la durée
 * d'un match en cours, affichée à la minute.
 *
 * Inactive, elle ne bat pas : un écran sans match en cours (le cas de loin le plus fréquent) ne
 * doit pas se re-rendre deux fois par minute pour rien. La fiche d'une rencontre, elle, n'est
 * pas sondée : sans cette horloge, le temps d'un match en cours y resterait figé à l'ouverture.
 */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Recalée tout de suite : l'horloge a pu dormir longtemps avant qu'un match ne commence.
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [active]);

  return now;
}
