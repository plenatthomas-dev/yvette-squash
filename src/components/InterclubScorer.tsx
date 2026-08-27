"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPoint,
  applyServe,
  BREAK_SECONDS,
  replay,
  resolveColor,
  seedEvents,
  undo as undoEvent,
  winGamesFor,
  type Box,
  type GameScore,
  type ScoreEvent,
  type Side,
} from "@/lib/interclub";
import { isSoundEnabled } from "@/lib/sound";

// Écran de marquage, au bord du terrain. Trois partis pris commandent tout le reste :
//
//  1. LOCAL-FIRST. Le journal des points vit dans `localStorage`, l'écran ne bloque JAMAIS sur
//     le réseau. Une salle de squash est un sous-sol : si compter dépendait d'une requête, le
//     marqueur abandonnerait au troisième échange.
//  2. L'état se DÉRIVE du journal (`replay`). L'undo est donc un `pop()` suivi d'un rejeu :
//     un seul chemin de code, aucune divergence possible entre l'écran et les données.
//  3. La synchro envoie l'ÉTAT COMPLET, jamais un delta — donc idempotente, donc une reprise
//     après coupure ne demande ni file ordonnée ni numéro de séquence.

const SYNC_MS = 5_000;
const LOG_PREFIX = "ic:log:";

type MatchInfo = {
  id: string;
  order: number;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  games: { number: number; home: number; away: number }[];
};

function loadLog(matchId: string): ScoreEvent[] | null {
  try {
    const raw = localStorage.getItem(LOG_PREFIX + matchId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScoreEvent[]) : null;
  } catch {
    return null;
  }
}

function saveLog(matchId: string, events: ScoreEvent[]) {
  try {
    localStorage.setItem(LOG_PREFIX + matchId, JSON.stringify(events));
  } catch {
    // Quota plein ou stockage refusé : on continue en mémoire. Perdre la reprise après
    // rechargement est regrettable, empêcher de compter le serait bien plus.
  }
}

export function clearLog(matchId: string) {
  try {
    localStorage.removeItem(LOG_PREFIX + matchId);
  } catch {
    /* sans importance */
  }
}

/** mm:ss */
function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function InterclubScorer({
  fixtureId,
  match,
  bestOf,
  onClose,
  onExpired,
  toast,
}: {
  fixtureId: string;
  match: MatchInfo;
  bestOf: number;
  onClose: () => void;
  onExpired: (status: number) => boolean;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  // Miroir toujours à jour du journal. Deux appuis très rapprochés — deux échanges gagnés coup
  // sur coup — ne doivent pas dépendre du fait que React ait rendu entre les deux : `commit`
  // part de cette référence, jamais de la valeur capturée par la fermeture de rendu.
  const eventsRef = useRef<ScoreEvent[]>([]);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [breakUntil, setBreakUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const state = replay(events, bestOf);
  const needed = winGamesFor(bestOf);
  const homeC = resolveColor(match.homeColor);
  const awayC = resolveColor(match.awayColor);

  // --- journal local ---------------------------------------------------------
  // Amorcé UNE SEULE FOIS par match. `match.games` est une référence de tableau reconstruite à
  // chaque rechargement du parent — donc à chaque retour au premier plan. Sans ce verrou,
  // l'amorçage se rejouait, et lorsque `localStorage` est indisponible (mode privé, quota) il
  // repartait des jeux connus du serveur : les points du jeu en cours étaient effacés, alors
  // que `saveLog` promet précisément de « continuer en mémoire ».
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === match.id) return;
    seededFor.current = match.id;
    const local = loadLog(match.id);
    // Pas de journal ici ? Le match a pu être entamé sur un autre téléphone, ou saisi à la
    // main. On repart des jeux connus du serveur (score fidèle, déroulé reconstitué).
    const seed = local ?? seedEvents(match.games.map((g) => ({ home: g.home, away: g.away })), bestOf);
    eventsRef.current = seed;
    setEvents(seed);
    setReady(true);
  }, [match.id, match.games, bestOf]);

  useEffect(() => {
    if (ready) saveLog(match.id, events);
  }, [ready, match.id, events]);

  // --- synchro serveur -------------------------------------------------------
  const lastSentRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ScoreEvent[] | null>(null);

  const push = useCallback(
    async (evts: ScoreEvent[]) => {
      const st = replay(evts, bestOf);
      try {
        const res = await fetch(`/api/interclub/${fixtureId}/matches/${match.id}/live`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            games: st.games,
            live: st.status === "done" ? null : {
              current: st.current,
              serving: st.serving,
              servingBox: st.servingBox,
              awaitingServeBox: st.awaitingServeBox,
            },
          }),
        });
        if (onExpired(res.status)) return;
        if (res.status === 409) {
          setOffline(false);
          toast("err", "Quelqu'un d'autre marque ce match.");
          return;
        }
        setOffline(!res.ok);
        lastSentRef.current = Date.now();
      } catch {
        // Hors-ligne : on garde la main, la prochaine tentative renverra l'état COMPLET.
        setOffline(true);
      }
    },
    [fixtureId, match.id, bestOf, onExpired, toast],
  );

  const scheduleSync = useCallback(
    (evts: ScoreEvent[], immediate: boolean) => {
      pendingRef.current = evts;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const wait = immediate ? 0 : Math.max(0, SYNC_MS - (Date.now() - lastSentRef.current));
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const p = pendingRef.current;
        pendingRef.current = null;
        if (p) push(p);
      }, wait);
    },
    [push],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // --- minuteur de pause -----------------------------------------------------
  useEffect(() => {
    if (breakUntil === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [breakUntil]);

  const remaining = breakUntil === null ? 0 : Math.max(0, Math.ceil((breakUntil - now) / 1000));
  useEffect(() => {
    if (breakUntil !== null && remaining === 0 && isSoundEnabled()) {
      // Réutilise le bip déjà connu des membres plutôt que d'inventer un son de plus.
      import("@/lib/sound").then((m) => m.playAlert()).catch(() => {});
    }
  }, [breakUntil, remaining]);

  // --- actions ---------------------------------------------------------------
  function commit(build: (prev: ScoreEvent[]) => ScoreEvent[], opts: { immediate?: boolean } = {}) {
    const prev = eventsRef.current;
    const next = build(prev);
    const before = replay(prev, bestOf);
    const after = replay(next, bestOf);
    eventsRef.current = next;
    setEvents(next);

    const gameEnded = after.games.length > before.games.length;
    const finished = after.status === "done";
    if (gameEnded && !finished) setBreakUntil(Date.now() + BREAK_SECONDS * 1000);
    // Une fin de jeu ou de match part tout de suite : c'est ce que les spectateurs attendent,
    // et c'est aussi le moment où le score doit être en sécurité côté serveur.
    scheduleSync(next, opts.immediate || gameEnded || finished);
  }

  const scorePoint = (side: Side) => {
    if (state.awaitingServeBox || state.status === "done" || remaining > 0) return;
    commit((prev) => applyPoint(prev, bestOf, side));
  };

  const chooseBox = (box: Box) => {
    if (!state.serving) return;
    const who = state.serving;
    commit((prev) => applyServe(prev, bestOf, who, box));
  };

  const chooseFirstServer = (side: Side, box: Box) =>
    commit((prev) => applyServe(prev, bestOf, side, box));

  const doUndo = () => {
    setBreakUntil(null);
    commit((prev) => undoEvent(prev), { immediate: true });
  };

  async function finish() {
    // On ATTEND l'envoi avant de fermer. `scheduleSync` pose un `setTimeout`, que le nettoyage
    // de l'effet annule au démontage : la dernière synchro reposait donc sur une course, et
    // les derniers points pouvaient ne jamais partir.
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    const latest = eventsRef.current;
    await push(latest);
    if (replay(latest, bestOf).status === "done") clearLog(match.id);
    onClose();
  }

  if (!ready) return null;

  const side = (who: Side) => {
    const isHome = who === "home";
    const c = isHome ? homeC : awayC;
    const name = isHome ? match.homeDisplayName : match.awayName;
    const pts = isHome ? state.current.home : state.current.away;
    const won = isHome ? state.gamesWon.home : state.gamesWon.away;
    const serving = state.serving === who;
    return (
      <button
        className="ics-side"
        style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
        onClick={() => scorePoint(who)}
        disabled={state.awaitingServeBox || state.status === "done" || remaining > 0}
        aria-label={`Point pour ${name}`}
      >
        <span className="ics-name">{name}</span>
        <span className="ics-points">{pts}</span>
        <span className="ics-won">
          <span className="sr-only">Jeux gagnés : </span>
          {won} jeu{won > 1 ? "x" : ""}
        </span>
        {serving && (
          <span className="ics-serve" title={`${name} sert`}>
            sert {state.servingBox === "left" ? "à gauche" : state.servingBox === "right" ? "à droite" : ""}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="ics" role="dialog" aria-label="Marquage du match">
      <header className="ics-head">
        <button className="secondary" onClick={() => void finish()}>
          ← Retour
        </button>
        <span className="ics-meta" title={`Match numéro ${match.order}, ${needed} jeux gagnants`}>
          Match #{match.order} · {needed} jeux gagnants
          {offline && (
            <span className="ics-offline" title="Les points sont gardés sur cet appareil">
              hors-ligne
            </span>
          )}
        </span>
        <button className="secondary" onClick={doUndo} disabled={events.length <= 1}>
          ↶ Annuler
        </button>
      </header>

      {state.games.length > 0 && (
        <p className="ics-history">
          {state.games.map((g: GameScore, i: number) => (
            <span key={i}>
              {g.home}-{g.away}
              {i < state.games.length - 1 ? " · " : ""}
            </span>
          ))}
        </p>
      )}

      <div className="ics-board">
        {side("home")}
        {side("away")}
      </div>

      {/* Premier service du match : il faut désigner qui sert ET de quel carré. */}
      {state.serving === null && state.status !== "done" && (
        <div className="ics-ask">
          <p>Qui engage&nbsp;?</p>
          <div className="ics-ask-row">
            <button onClick={() => chooseFirstServer("home", "right")}>
              {match.homeDisplayName} · droite
            </button>
            <button onClick={() => chooseFirstServer("home", "left")}>
              {match.homeDisplayName} · gauche
            </button>
          </div>
          <div className="ics-ask-row">
            <button onClick={() => chooseFirstServer("away", "right")}>
              {match.awayName} · droite
            </button>
            <button onClick={() => chooseFirstServer("away", "left")}>
              {match.awayName} · gauche
            </button>
          </div>
        </div>
      )}

      {/* Reprise de service : le carré ne se déduit pas, le joueur le CHOISIT. */}
      {state.awaitingServeBox && state.serving && state.status !== "done" && remaining === 0 && (
        <div className="ics-ask">
          <p>
            {state.serving === "home" ? match.homeDisplayName : match.awayName} sert&nbsp;:
          </p>
          <div className="ics-ask-row">
            <button onClick={() => chooseBox("right")}>Carré droit</button>
            <button onClick={() => chooseBox("left")}>Carré gauche</button>
          </div>
        </div>
      )}

      {/* Pause réglementaire entre deux jeux. Interruptible : les pauses réelles ne suivent
          pas toujours le règlement, et un minuteur qu'on ne peut pas passer devient un
          obstacle plutôt qu'une aide. */}
      {remaining > 0 && (
        <div className="ics-ask">
          <p className="ics-timer">{mmss(remaining)}</p>
          <p className="muted tiny">Pause entre les jeux</p>
          <div className="ics-ask-row">
            <button onClick={() => setBreakUntil(null)}>Reprendre maintenant</button>
          </div>
        </div>
      )}

      {state.status === "done" && (
        <div className="ics-ask">
          <p className="ics-done">
            {state.winner === "home" ? match.homeDisplayName : match.awayName} l&apos;emporte{" "}
            {state.gamesWon.home}–{state.gamesWon.away}
          </p>
          <div className="ics-ask-row">
            <button onClick={() => void finish()}>Terminer</button>
          </div>
        </div>
      )}
    </div>
  );
}
