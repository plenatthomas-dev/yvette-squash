"use client";

// Diffuse l'état runtime des fonctions à toute l'UI (étape #9).
//
// Amorcé avec ENV_FEATURES — les valeurs inlinées au build — pour que le PREMIER rendu soit
// déjà juste dans le cas courant (aucun override posé) : pas de flash « bouton grisé puis
// actif ». Le fetch de /api/features n'ajuste ensuite que si un admin a forcé un flag.
//
// Rappel : ceci ne protège rien. Couper un flag ici ne fait que masquer l'UI ; le refus vient
// des routes API (features-server).

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ENV_FEATURES, parseOverrides, resolveFeatures, type Features } from "@/lib/features";

const FeatureContext = createContext<Features>(ENV_FEATURES);

/** État effectif des fonctions. Hors provider : les défauts de l'environnement. */
export function useFeatures(): Features {
  return useContext(FeatureContext);
}

/**
 * Signal « les fonctions ont changé », à émettre après une bascule dans /admin.
 *
 * Ce provider est monté dans le LAYOUT : il survit à toutes les navigations client et ne se
 * remontait donc jamais. Il ne lisait /api/features qu'une fois, au tout premier chargement.
 * Conséquence : un admin basculait un flag, revenait à l'accueil, et l'UI gardait l'ancien
 * état jusqu'à un rechargement complet du navigateur.
 * Même idiome que la bannière d'annonce (événement `window`) : le panneau d'admin et le
 * provider ne se connaissent pas et n'ont pas à se connaître.
 */
export const FEATURES_EVENT = "app-features-changed";

export function notifyFeaturesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEATURES_EVENT));
}

export default function FeatureProvider({ children }: { children: React.ReactNode }) {
  const [features, setFeatures] = useState<Features>(ENV_FEATURES);
  // Relit aussi à chaque changement de route : couvre le retour depuis /admin même si le
  // signal s'est perdu, et le cas d'un flag basculé depuis un autre appareil.
  const pathname = usePathname();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/features", { cache: "no-store" });
      if (!res.ok) return; // on garde les défauts d'env
      const data = (await res.json()) as { features?: unknown };
      // On repasse par parseOverrides + resolveFeatures : la réponse est traitée comme une
      // source non fiable, une clé manquante retombe sur l'env plutôt que sur `undefined`.
      setFeatures(resolveFeatures(parseOverrides(data.features)));
    } catch {
      // Réseau KO → défauts d'env, l'appli reste utilisable.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener(FEATURES_EVENT, onChanged);
    return () => window.removeEventListener(FEATURES_EVENT, onChanged);
  }, [refresh]);

  return <FeatureContext.Provider value={features}>{children}</FeatureContext.Provider>;
}
