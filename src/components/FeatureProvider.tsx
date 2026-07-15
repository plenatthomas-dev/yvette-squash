"use client";

// Diffuse l'état runtime des fonctions à toute l'UI (étape #9).
//
// Amorcé avec ENV_FEATURES — les valeurs inlinées au build — pour que le PREMIER rendu soit
// déjà juste dans le cas courant (aucun override posé) : pas de flash « bouton grisé puis
// actif ». Le fetch de /api/features n'ajuste ensuite que si un admin a forcé un flag.
//
// Rappel : ceci ne protège rien. Couper un flag ici ne fait que masquer l'UI ; le refus vient
// des routes API (features-server).

import { createContext, useContext, useEffect, useState } from "react";
import { ENV_FEATURES, parseOverrides, resolveFeatures, type Features } from "@/lib/features";

const FeatureContext = createContext<Features>(ENV_FEATURES);

/** État effectif des fonctions. Hors provider : les défauts de l'environnement. */
export function useFeatures(): Features {
  return useContext(FeatureContext);
}

export default function FeatureProvider({ children }: { children: React.ReactNode }) {
  const [features, setFeatures] = useState<Features>(ENV_FEATURES);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/features");
        if (!res.ok) return; // on garde les défauts d'env
        const data = (await res.json()) as { features?: unknown };
        // On repasse par parseOverrides + resolveFeatures : la réponse est traitée comme une
        // source non fiable, une clé manquante retombe sur l'env plutôt que sur `undefined`.
        if (alive) setFeatures(resolveFeatures(parseOverrides(data.features)));
      } catch {
        // Réseau KO → défauts d'env, l'appli reste utilisable.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return <FeatureContext.Provider value={features}>{children}</FeatureContext.Provider>;
}
