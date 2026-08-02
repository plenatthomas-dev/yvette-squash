"use client";

import { useEffect } from "react";

// Signale au DOCUMENT qu'une barre d'action est collée en bas de l'écran.
//
// Pourquoi ce détour par `document.body` : la barre « Réserver » est rendue par les grilles
// (PlanningGrid / WeekGrid), tandis que la bannière d'installation PWA est montée dans le
// LAYOUT, très loin dans l'arbre. Les deux sont `position: fixed; bottom: 0`, et la bannière
// était au-dessus (z-index 900 contre 50) : sur iOS Safari, où elle s'affiche immédiatement et
// persiste 14 jours, elle RECOUVRAIT le bouton qui valide la réservation. Sur Android en mode
// « prompt », un tap dans la zone recouverte déclenchait l'installation de la PWA AU LIEU de
// la réservation — un geste qui produit silencieusement le mauvais résultat.
//
// Aucun état partagé ne relie ces deux composants ; un attribut sur `body` est le canal le
// plus simple et le plus sûr, et il permet à la CSS de trancher seule (cf. globals.css).
// `--bottombar-h` sert aussi à remonter les toasts au-dessus de la barre.
const ATTR = "data-bottombar";
const VAR = "--bottombar-h";

export function useBottomBar(active: boolean, height = 64): void {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    body.setAttribute(ATTR, "1");
    body.style.setProperty(VAR, `${height}px`);
    return () => {
      body.removeAttribute(ATTR);
      body.style.removeProperty(VAR);
    };
  }, [active, height]);
}
