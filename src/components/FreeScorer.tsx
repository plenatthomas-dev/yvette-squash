"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  applyPoint,
  applyServe,
  colorsTooClose,
  replay,
  resolveColor,
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
  summarize,
  type FreeMatch,
} from "@/lib/free-scorer";
import { useBreakTimer } from "@/lib/useBreakTimer";
import { keepAwake } from "@/lib/wake-lock";
import ColorPicker from "./ColorPicker";
import { ShareIcon, TrashIcon } from "./icons";
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

function prettyDay(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Le score d'un match, en tableau de marque : une ligne par joueur, ses points jeu par jeu,
 * puis ses jeux gagnés en gros. C'est la forme qu'on lit sans réfléchir sur n'importe quel
 * écran de sport — là où une phrase (« Paul bat Marc 2-1 (11-7, 9-11, 11-4) ») obligeait à
 * remettre les nombres en face des noms.
 *
 * Match terminé : le vainqueur en tête et en gras. En cours : l'ordre de saisie, et une colonne
 * de plus pour le jeu en cours, peinte comme l'est « en cours » partout ailleurs.
 *
 * Le lecteur d'écran reçoit la phrase (`resultLine`) : le tableau est une aide VISUELLE, et le
 * lire case par case serait plus long que la phrase.
 */
function MatchScore({ m }: { m: FreeMatch }) {
  const s = summarize(m);
  const rows = [s.first, s.second] as const;
  return (
    <div className="fs-score" role="img" aria-label={resultLine(m)}>
      {rows.map((side, r) => {
        const c = resolveColor(m[side].color);
        const winner = s.done && r === 0;
        return (
          <div key={side} className={"fs-score-row" + (winner ? " is-winner" : "")}>
            <span
              className={"fs-dot" + (c ? "" : " is-none")}
              style={c ? { background: c.bg } : undefined}
            />
            <span className="fs-name">{m[side].name}</span>
            <span className="fs-games">
              {s.games.map((g, i) => (
                <span key={i} className={g[r] > g[1 - r] ? "is-won" : ""}>
                  {g[r]}
                </span>
              ))}
              {s.current && (
                <span className="fs-current">{s.current[side === "home" ? 0 : 1]}</span>
              )}
            </span>
            <strong className="fs-won">{s.gamesWon[r]}</strong>
          </div>
        );
      })}
    </div>
  );
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
  // `""` = pas de couleur : c'est la convention de `ColorPicker`, partagé avec l'interclub.
  const [homeColor, setHomeColor] = useState("");
  const [awayColor, setAwayColor] = useState("");
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
      home: { name: cleanName(homeName, "Joueur 1"), color: homeColor || null },
      away: { name: cleanName(awayName, "Joueur 2"), color: awayColor || null },
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

  // Le match qu'on vient de finir a sa propre carte, bouton de partage en avant : on ne le
  // répète pas en tête de l'historique juste en dessous.
  const others = last ? history.filter((m) => m.id !== last.id) : history;

  return (
    <section className="free-scorer">
      <h2>🎯 Marqueur</h2>
      <p className="muted tiny">
        Pour compter un match amical, un entraînement… Les scores restent sur ce téléphone.
      </p>

      {last && (
        <article className="fs-card fs-last" aria-live="polite">
          <h3>Match terminé</h3>
          <MatchScore m={last} />
          <button type="button" className="fs-share" onClick={() => void shareResult(resultLine(last), toast)}>
            <ShareIcon />
            Partager le résultat
          </button>
        </article>
      )}

      {current ? (
        <article className="fs-card fs-live">
          {/* Pas de pastille « en cours » : le titre le dit déjà, et le voile ambre de la carte
              est la marque de cet état partout dans le produit. */}
          <h3>Match en cours</h3>
          <MatchScore m={current} />
          <div className="fs-actions">
            {confirmAbandon ? (
              <>
                <button type="button" className="cancel" onClick={abandon}>
                  Oui, abandonner
                </button>
                <button type="button" className="secondary outline" onClick={() => setConfirmAbandon(false)}>
                  Non, garder
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setPlaying(true)}>
                  Reprendre
                </button>
                <button type="button" className="secondary outline" onClick={() => setConfirmAbandon(true)}>
                  Abandonner
                </button>
              </>
            )}
          </div>
        </article>
      ) : (
        <article className="fs-card">
          <form
            className="fs-setup"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            <h3>Nouveau match</h3>
            <label>
              Joueur 1
              <span className="ic-field-row">
                <input
                  value={homeName}
                  onChange={(e) => setHomeName(e.target.value)}
                  placeholder="Joueur 1"
                  maxLength={40}
                  autoComplete="off"
                  enterKeyHint="next"
                />
                <ColorPicker value={homeColor} onChange={setHomeColor} label="Couleur du joueur 1" />
              </span>
            </label>
            <label>
              Joueur 2
              <span className="ic-field-row">
                <input
                  value={awayName}
                  onChange={(e) => setAwayName(e.target.value)}
                  placeholder="Joueur 2"
                  maxLength={40}
                  autoComplete="off"
                  enterKeyHint="go"
                />
                <ColorPicker value={awayColor} onChange={setAwayColor} label="Couleur du joueur 2" />
              </span>
            </label>
            {colorsTooClose(homeColor, awayColor) && (
              <p className="notice tiny ic-problem" role="status">
                Ces deux couleurs se ressemblent trop pour distinguer les joueurs d&apos;un coup
                d&apos;œil.
              </p>
            )}
            <fieldset className="trn-choice">
              <legend>Format</legend>
              <button
                type="button"
                className={bestOf === 3 ? "on" : ""}
                aria-pressed={bestOf === 3}
                onClick={() => setBestOf(3)}
              >
                2 jeux gagnants
              </button>
              <button
                type="button"
                className={bestOf === 5 ? "on" : ""}
                aria-pressed={bestOf === 5}
                onClick={() => setBestOf(5)}
              >
                3 jeux gagnants
              </button>
            </fieldset>
            <button type="submit">Commencer</button>
          </form>
        </article>
      )}

      {others.length > 0 && (
        <article className="fs-card fs-history">
          <h3>Derniers matchs</h3>
          <ul>
            {others.map((m) => (
              <li key={m.id}>
                <span className="fs-date">{prettyDay(m.startedAt)}</span>
                <MatchScore m={m} />
                <span className="fs-row-actions">
                  <button
                    type="button"
                    className="secondary outline icon-btn"
                    aria-label={`Partager : ${resultLine(m)}`}
                    title="Partager"
                    onClick={() => void shareResult(resultLine(m), toast)}
                  >
                    <ShareIcon />
                  </button>
                  <button
                    type="button"
                    className="secondary outline icon-btn"
                    aria-label={`Effacer : ${resultLine(m)}`}
                    title="Effacer"
                    onClick={() => forget(m.id)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
