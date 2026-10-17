"use client";

import { useEffect, useState } from "react";
import { elapsedMs, type MatchTimes } from "@/lib/interclub-duree";
import { mmss } from "./ScoreBoard";

/**
 * Le chrono de l'écran de marquage : temps de jeu depuis le premier point, à la seconde. Figé
 * sur la durée finale au point décisif ; rien avant le premier point.
 *
 * UN COMPOSANT À PART pour que la seconde qui passe ne re-rende que lui. Logé dans `ScoreBoard`,
 * il aurait redessiné chaque seconde les deux grandes cases, dont la typographie se recalcule
 * en requêtes de conteneur.
 *
 * Il ne bat que tant que le match court : fini, ou pas commencé, aucun intervalle.
 */
export default function MatchClock({ times }: { times: MatchTimes<number> }) {
  const running = times.startedAt !== null && times.finishedAt === null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const ms = elapsedMs(times.startedAt, times.finishedAt, now);
  if (ms === null) return null;
  // `role="timer"` : un lecteur d'écran ne l'annonce PAS à chaque seconde (pas de région vive),
  // on le lit quand on y va.
  return (
    <span className="ics-clock" role="timer" aria-label={`Temps de jeu ${mmss(Math.floor(ms / 1000))}`}>
      {mmss(Math.floor(ms / 1000))}
    </span>
  );
}
