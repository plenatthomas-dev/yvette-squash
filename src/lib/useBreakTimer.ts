"use client";

import { useEffect, useState } from "react";
import { BREAK_SECONDS } from "@/lib/interclub";
import { isSoundEnabled } from "@/lib/sound";

/**
 * Minuteur de la pause réglementaire entre deux jeux, partagé par les deux marquages
 * (interclub et marqueur libre). `remaining` vaut 0 hors pause.
 */
export function useBreakTimer() {
  const [breakUntil, setBreakUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (breakUntil === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [breakUntil]);

  const remaining = breakUntil === null ? 0 : Math.max(0, Math.ceil((breakUntil - now) / 1000));
  useEffect(() => {
    if (breakUntil === null || remaining > 0) return;
    if (isSoundEnabled()) {
      // Réutilise le bip déjà connu des membres plutôt que d'inventer un son de plus.
      import("@/lib/sound").then((m) => m.playAlert()).catch(() => {});
    }
    // La pause est FINIE : on l'éteint ici, et pas seulement sur « Reprendre maintenant » ou
    // sur un undo. Sans cela `breakUntil` restait posé, donc l'intervalle de 500 ms continuait
    // de battre — deux rendus complets de l'écran par seconde jusqu'au jeu suivant, alors que
    // le panneau de pause a déjà disparu et que plus rien ne dépend de `now`.
    setBreakUntil(null);
  }, [breakUntil, remaining]);

  return {
    remaining,
    startBreak: () => setBreakUntil(Date.now() + BREAK_SECONDS * 1000),
    stopBreak: () => setBreakUntil(null),
  };
}
