"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  applyPoint,
  applyServe,
  colorsTooClose,
  COLOR_PRESETS,
  replay,
  undo as undoEvent,
  winGamesFor,
  type Box,
  type ScoreEvent,
  type Side,
} from "@/lib/interclub";
import {
  cleanName,
  CURRENT_KEY,
  loadHistory,
  loadMatch,
  newId,
  pushHistory,
  removeKey,
  resultLine,
  saveHistory,
  saveMatch,
  type FreeMatch,
} from "@/lib/free-scorer";
import { useBreakTimer } from "@/lib/useBreakTimer";
import { keepAwake } from "@/lib/wake-lock";
import ScoreBoard, { hapticFor } from "./ScoreBoard";

type Toast = (type: "ok" | "err" | "info", msg: string) => void;

/**
 * Partage le résultat : feuille de partage du système quand elle existe (téléphone), sinon
 * copie dans le presse-papier. Une annulation de la feuille par l'utilisateur n'est pas une
 * erreur et ne dit rien.
 */
export async function shareResult(text: string, toast: Toast) {
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({ text });
      return;
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    // Partage refusé (contexte non sécurisé, permission) : on tente la copie.
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("ok", "Résultat copié");
  } catch {
    toast("err", "Partage impossible sur cet appareil");
  }
}

/**
 * Un match marqué au bord du court, journal gardé sur le téléphone à chaque appui.
 *
 * Même écran que l'interclub (`ScoreBoard`), sans synchro : rien ne part sur le réseau pendant
 * le match. C'est l'appelant qui décide quoi faire du match terminé (`onFinish`) — historique
 * local pour le marqueur libre, envoi du résultat pour un match de tournoi.
 */
export function FreeScoringSession({
  match,
  storageKey,
  meta,
  finishLabel,
  onBack,
  onFinish,
}: {
  match: FreeMatch;
  storageKey: string;
  meta?: ReactNode;
  finishLabel?: string;
  /** Sortie SANS terminer : le journal reste, le match se reprend plus tard. */
  onBack: (m: FreeMatch) => void;
  /** Match terminé, « Terminer » tapé. Peut être asynchrone (envoi du résultat). */
  onFinish: (m: FreeMatch) => void | Promise<void>;
}) {
  const { bestOf } = match;
  const [events, setEvents] = useState<ScoreEvent[]>(match.events);
  // Miroir synchrone du journal : deux appuis rapprochés ne doivent pas dépendre d'un rendu
  // intermédiaire (même raison que dans `InterclubScorer`).
  const eventsRef = useRef<ScoreEvent[]>(match.events);
  const [busy, setBusy] = useState(false);
  const { remaining, startBreak, stopBreak } = useBreakTimer();

  const state = replay(events, bestOf);
  const snapshot = (): FreeMatch => ({ ...match, events: eventsRef.current });

  useEffect(() => keepAwake(), []);

  function commit(build: (prev: ScoreEvent[]) => ScoreEvent[]) {
    const prev = eventsRef.current;
    const next = build(prev);
    const before = replay(prev, bestOf);
    const after = replay(next, bestOf);
    eventsRef.current = next;
    setEvents(next);
    // Sauvé À CHAQUE APPUI, synchrone : un rechargement ou un onglet tué par le système entre
    // deux échanges ne doit rien coûter.
    saveMatch(storageKey, { ...match, events: next });
    hapticFor(before, after);
    if (after.games.length > before.games.length && after.status !== "done") startBreak();
  }

  const scorePoint = (side: Side) => {
    if (state.serving === null || state.awaitingServeBox || state.status === "done" || remaining > 0)
      return;
    commit((prev) => applyPoint(prev, bestOf, side));
  };

  const chooseBox = (box: Box) => {
    if (!state.serving) return;
    const who = state.serving;
    commit((prev) => applyServe(prev, bestOf, who, box));
  };

  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      await onFinish(snapshot());
    } finally {
      setBusy(false);
    }
  }

  const needed = winGamesFor(bestOf);
  return (
    <ScoreBoard
      state={state}
      bestOf={bestOf}
      homeName={match.home.name}
      awayName={match.away.name}
      homeColor={match.home.color}
      awayColor={match.away.color}
      metaTitle={`${needed} jeux gagnants`}
      meta={meta ?? <>{needed} jeux gagnants</>}
      canUndo={events.length > 0}
      remaining={remaining}
      onPoint={scorePoint}
      onFirstServe={(side, box) => commit((prev) => applyServe(prev, bestOf, side, box))}
      onBox={chooseBox}
      onUndo={() => {
        stopBreak();
        commit((prev) => undoEvent(prev));
      }}
      onSkipBreak={stopBreak}
      onBack={() => onBack(snapshot())}
      onFinish={() => void finish()}
      finishLabel={finishLabel}
      finishBusy={busy}
    />
  );
}

function Swatches({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  return (
    <div className="fs-swatches" role="radiogroup" aria-label={label}>
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label="Aucune couleur"
        title="Aucune couleur"
        className={`ic-swatch ic-swatch-none${value === null ? " is-on" : ""}`}
        onClick={() => onChange(null)}
      />
      {COLOR_PRESETS.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={value === c.hex}
          aria-label={c.label}
          title={c.label}
          className={`ic-swatch${value === c.hex ? " is-on" : ""}`}
          style={{ background: c.hex }}
          onClick={() => onChange(c.hex)}
        />
      ))}
    </div>
  );
}

function prettyDay(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Vue « Marqueur » : compter un match hors interclub, depuis le menu général.
 *
 * Un seul match en cours à la fois (proposé en reprise à l'ouverture, jamais écrasé en
 * silence), et les derniers matchs terminés gardés sur ce téléphone. Rien n'est envoyé au
 * serveur — cf. `lib/free-scorer.ts`.
 */
export default function FreeScorer({ toast }: { toast: Toast }) {
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<FreeMatch | null>(null);
  const [playing, setPlaying] = useState(false);
  const [history, setHistory] = useState<FreeMatch[]>([]);
  const [last, setLast] = useState<FreeMatch | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  const [homeName, setHomeName] = useState("");
  const [awayName, setAwayName] = useState("");
  const [homeColor, setHomeColor] = useState<string | null>(null);
  const [awayColor, setAwayColor] = useState<string | null>(null);
  const [bestOf, setBestOf] = useState<3 | 5>(3);

  // localStorage n'existe qu'au navigateur : lu après le montage, jamais au rendu serveur.
  useEffect(() => {
    setCurrent(loadMatch(CURRENT_KEY));
    setHistory(loadHistory());
    setReady(true);
  }, []);

  const start = () => {
    const m: FreeMatch = {
      id: newId(),
      startedAt: Date.now(),
      home: { name: cleanName(homeName, "Joueur 1"), color: homeColor },
      away: { name: cleanName(awayName, "Joueur 2"), color: awayColor },
      bestOf,
      events: [],
    };
    saveMatch(CURRENT_KEY, m);
    setCurrent(m);
    setLast(null);
    setPlaying(true);
  };

  const abandon = () => {
    removeKey(CURRENT_KEY);
    setCurrent(null);
    setConfirmAbandon(false);
  };

  const finish = (m: FreeMatch) => {
    const next = pushHistory(history, m);
    saveHistory(next);
    setHistory(next);
    removeKey(CURRENT_KEY);
    setCurrent(null);
    setLast(m);
    setPlaying(false);
  };

  const forget = (id: string) => {
    const next = history.filter((m) => m.id !== id);
    saveHistory(next);
    setHistory(next);
    if (last?.id === id) setLast(null);
  };

  if (!ready) return null;

  if (playing && current) {
    return (
      <FreeScoringSession
        match={current}
        storageKey={CURRENT_KEY}
        onBack={(m) => {
          setCurrent(m);
          setPlaying(false);
        }}
        onFinish={finish}
      />
    );
  }

  const tooClose = !!homeColor && !!awayColor && colorsTooClose(homeColor, awayColor);

  return (
    <section className="free-scorer">
      <h2>🎯 Marqueur</h2>
      <p className="muted tiny">
        Pour compter un match amical, un entraînement… Les scores restent sur ce téléphone.
      </p>

      {last && (
        <article className="fs-card fs-result" aria-live="polite">
          <p className="fs-line">{resultLine(last)}</p>
          <button type="button" onClick={() => void shareResult(resultLine(last), toast)}>
            Partager le résultat
          </button>
        </article>
      )}

      {current ? (
        <article className="fs-card">
          <h3>Match en cours</h3>
          <p className="fs-line">{resultLine(current)}</p>
          <div className="fs-actions">
            <button type="button" onClick={() => setPlaying(true)}>
              Reprendre
            </button>
            {confirmAbandon ? (
              <>
                <button type="button" className="cancel" onClick={abandon}>
                  Confirmer l&apos;abandon
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmAbandon(false)}>
                  Garder
                </button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirmAbandon(true)}>
                Abandonner
              </button>
            )}
          </div>
        </article>
      ) : (
        <form
          className="fs-card fs-setup"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <h3>Nouveau match</h3>
          <label>
            Joueur 1
            <input
              value={homeName}
              onChange={(e) => setHomeName(e.target.value)}
              placeholder="Joueur 1"
              maxLength={40}
              autoComplete="off"
            />
          </label>
          <Swatches value={homeColor} onChange={setHomeColor} label="Couleur du joueur 1" />
          <label>
            Joueur 2
            <input
              value={awayName}
              onChange={(e) => setAwayName(e.target.value)}
              placeholder="Joueur 2"
              maxLength={40}
              autoComplete="off"
            />
          </label>
          <Swatches value={awayColor} onChange={setAwayColor} label="Couleur du joueur 2" />
          {tooClose && (
            <p className="muted tiny" role="status">
              ⚠️ Couleurs très proches : difficile de distinguer les joueurs.
            </p>
          )}
          <fieldset className="fs-format">
            <legend>Format</legend>
            <label>
              <input
                type="radio"
                name="fs-bestof"
                checked={bestOf === 3}
                onChange={() => setBestOf(3)}
              />
              2 jeux gagnants
            </label>
            <label>
              <input
                type="radio"
                name="fs-bestof"
                checked={bestOf === 5}
                onChange={() => setBestOf(5)}
              />
              3 jeux gagnants
            </label>
          </fieldset>
          <button type="submit">Commencer</button>
        </form>
      )}

      {history.length > 0 && (
        <div className="fs-history">
          <h3>Derniers matchs</h3>
          <ul>
            {history.map((m) => (
              <li key={m.id}>
                <span className="fs-date muted tiny">{prettyDay(m.startedAt)}</span>
                <span className="fs-line">{resultLine(m)}</span>
                <span className="fs-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void shareResult(resultLine(m), toast)}
                  >
                    Partager
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Effacer ${resultLine(m)}`}
                    onClick={() => forget(m.id)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
