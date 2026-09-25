"use client";

import type { ReactNode } from "react";
import {
  ballPoint,
  resolveColor,
  type Box,
  type GameScore,
  type MatchState,
  type Side,
} from "@/lib/interclub";

// L'écran de marquage, sans rien savoir d'où viennent ni où partent les points.
//
// Il est partagé par le marquage d'un simple d'interclub (`InterclubScorer`, synchronisé avec
// le serveur) et par le marqueur libre (`FreeScorer`, gardé sur le téléphone). Tout ce qui
// touche au journal — le tenir, le sauver, l'envoyer — reste chez l'appelant : ce composant
// ne fait qu'afficher un `MatchState` et remonter les appuis.

/** mm:ss */
export function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Retour haptique d'un appui.
 *
 * LE MARQUAGE EST LE SEUL ÉCRAN QU'ON UTILISE SANS LE REGARDER : on tape, et on regarde le
 * court. Une brève vibration confirme l'appui sans lever les yeux — et une double vibration
 * dit qu'un jeu vient de tomber, ce qui est l'autre information qu'on cherchait à l'écran.
 *
 * ⚠️ 30 ms, ET NON 12. Le premier essai reprenait la durée du Fil (12 ms), et elle ne se
 * sentait pas : là-bas c'est un tic discret sur un écran qu'on REGARDE, ici c'est la seule
 * confirmation d'un geste fait en regardant ailleurs. Surtout, `vibrate` ne pilote que la
 * DURÉE — jamais l'intensité — et les moteurs à résonance linéaire des téléphones récents
 * mettent quelques dizaines de millisecondes à monter en amplitude : en dessous, le moteur
 * n'a pas fini de démarrer que l'ordre est déjà fini. 30 ms se sent sans être désagréable
 * sur une main qui tient l'appareil.
 *
 * `?.` parce que l'API n'existe nulle part chez Apple — ni Safari iOS, ni aucun navigateur
 * sur iPhone, qui utilisent tous le moteur de Safari. Sur ces appareils il n'y aura JAMAIS
 * de retour haptique ici, et ce n'est pas rattrapable côté web. Le marquage fonctionne
 * exactement pareil sans elle : même doctrine que le verrou d'écran.
 */
export function hapticFor(before: MatchState, after: MatchState) {
  const gameEnded = after.games.length > before.games.length;
  if (
    after.games.length !== before.games.length ||
    after.current.home !== before.current.home ||
    after.current.away !== before.current.away
  ) {
    navigator.vibrate?.(gameEnded ? [40, 70, 40] : 30);
  }
}

export default function ScoreBoard({
  state,
  bestOf,
  homeName,
  awayName,
  homeColor,
  awayColor,
  meta,
  metaTitle,
  canUndo,
  remaining,
  onPoint,
  onFirstServe,
  onBox,
  onUndo,
  onSkipBreak,
  onBack,
  onFinish,
  finishLabel = "Terminer",
  finishBusy = false,
}: {
  state: MatchState;
  bestOf: number;
  homeName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  /** Contenu du bandeau central (numéro du match, format, badge hors-ligne…). */
  meta: ReactNode;
  metaTitle?: string;
  canUndo: boolean;
  /** Secondes de pause restantes, 0 hors pause. */
  remaining: number;
  onPoint: (side: Side) => void;
  onFirstServe: (side: Side, box: Box) => void;
  onBox: (box: Box) => void;
  onUndo: () => void;
  onSkipBreak: () => void;
  onBack: () => void;
  onFinish: () => void;
  finishLabel?: string;
  finishBusy?: boolean;
}) {
  const homeC = resolveColor(homeColor);
  const awayC = resolveColor(awayColor);

  /**
   * Tant que le premier serveur n'est pas désigné, marquer n'a pas de sens — et `applyPoint`
   * IGNORE d'ailleurs un point dans cet état (« on ne devine pas un serveur »). Sans cette
   * condition, les deux grandes cases restaient actives et absorbaient les appuis en silence :
   * le pire des états pour un écran qu'on utilise sans le regarder, au bord du terrain.
   */
  const attendServeur = state.serving === null;

  // Qui tient une balle de jeu — et si c'est une balle de match. La règle vit dans
  // `interclub.ts` (`ballPoint`), l'écran ne fait que l'afficher : une seconde copie du
  // « 11 points et 2 d'écart » finirait par diverger, et l'écart ne se verrait qu'à 10-10.
  //
  // Éteint pendant la pause et une fois le match fini : « balle de match » sous un score final
  // n'annonce plus rien, et une balle de jeu à côté d'un minuteur de deux minutes non plus.
  const balle =
    state.status === "done" || remaining > 0 ? null : ballPoint(state.current, state.gamesWon, bestOf);

  const side = (who: Side) => {
    const isHome = who === "home";
    const c = isHome ? homeC : awayC;
    const name = isHome ? homeName : awayName;
    const pts = isHome ? state.current.home : state.current.away;
    const won = isHome ? state.gamesWon.home : state.gamesWon.away;
    const serving = state.serving === who;
    return (
      <button
        className="ics-side"
        style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
        onClick={() => onPoint(who)}
        disabled={
          attendServeur || state.awaitingServeBox || state.status === "done" || remaining > 0
        }
        aria-label={`Point pour ${name}`}
      >
        <span className="ics-name">{name}</span>
        {/* Coin HAUT-DROIT, le seul des quatre qui restait libre : le score garde le centre
            entier, et l'annonce ne lui prend pas un pixel de hauteur. C'est ce qu'un marqueur
            dit à voix haute avant l'échange, et l'écran le savait déjà sans jamais le dire. */}
        {balle?.side === who && (
          <span className={`ics-balle${balle.match ? " ics-balle-match" : ""}`}>
            {balle.match ? "balle de match" : "balle de jeu"}
          </span>
        )}
        <span className="ics-points">{pts}</span>
        {/* Barre du bas : jeux gagnés à gauche, carré de service à droite. Groupés plutôt que
            posés chacun dans son coin — sur une case étroite (téléphone debout), « sert à
            gauche » et « 1 jeu » ne tiennent pas côte à côte, et se chevauchaient. Ici la
            barre se replie sur deux lignes au lieu de les superposer. */}
        <span className="ics-foot">
          <span className="ics-won">
            <span className="sr-only">Jeux gagnés : </span>
            {won} jeu{won > 1 ? "x" : ""}
          </span>
          {serving && (
            <span className="ics-serve" title={`${name} sert`}>
              sert {state.servingBox === "left" ? "à gauche" : state.servingBox === "right" ? "à droite" : ""}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="ics" role="dialog" aria-label="Marquage du match">
      <header className="ics-head">
        <button className="secondary" onClick={onBack}>
          ← Retour
        </button>
        <span className="ics-meta" title={metaTitle}>
          {meta}
        </span>
        {/* ⚠️ ACTIF DÈS LE PREMIER ÉVÉNEMENT, et c'est une correction. La garde était
            `length <= 1`, ce qui rendait le CHOIX DU PREMIER SERVEUR indéfaisable : sur un match
            vierge, `seedEvents` rend une liste vide, le « Qui engage ? » y pose l'événement n° 1,
            et un appui de travers condamnait l'indicateur de service pour tout le match (le
            score, lui, n'était pas touché). Marquer un point puis l'annuler ne rattrapait rien —
            on retombait à 1.

            Cette garde ne protégeait rien d'autre : on pouvait déjà défaire, un par un, tous les
            événements reconstruits d'un match repris. Elle n'ajoutait qu'un plancher arbitraire,
            exactement là où il fallait pouvoir se corriger. */}
        <button className="secondary" onClick={onUndo} disabled={!canUndo}>
          ↶ Annuler
        </button>
      </header>

      {/* TOUJOURS RENDUE, même vide (sa hauteur est réservée en CSS). Conditionner son
          affichage faisait sauter le tableau d'un cran au premier jeu terminé, et toute la
          typographie des cases avec lui — elle se règle en requêtes de conteneur sur la case,
          donc sur sa hauteur. */}
      <p className="ics-history">
        {state.games.map((g: GameScore, i: number) => (
          <span key={i}>
            {g.home}-{g.away}
            {i < state.games.length - 1 ? " · " : ""}
          </span>
        ))}
      </p>

      <div className="ics-board">
        {side("home")}
        {side("away")}
      </div>

      {/* Premier service du match : il faut désigner qui sert ET de quel carré. */}
      {state.serving === null && state.status !== "done" && (
        <div className="ics-ask">
          <p>Qui engage&nbsp;?</p>
          <div className="ics-ask-row">
            <button onClick={() => onFirstServe("home", "left")}>{homeName} · gauche</button>
            <button onClick={() => onFirstServe("home", "right")}>{homeName} · droite</button>
          </div>
          <div className="ics-ask-row">
            <button onClick={() => onFirstServe("away", "left")}>{awayName} · gauche</button>
            <button onClick={() => onFirstServe("away", "right")}>{awayName} · droite</button>
          </div>
        </div>
      )}

      {/* Reprise de service : le carré ne se déduit pas, le joueur le CHOISIT. */}
      {state.awaitingServeBox && state.serving && state.status !== "done" && remaining === 0 && (
        <div className="ics-ask">
          <p>{state.serving === "home" ? homeName : awayName} sert&nbsp;:</p>
          <div className="ics-ask-row">
            <button onClick={() => onBox("left")}>Carré gauche</button>
            <button onClick={() => onBox("right")}>Carré droit</button>
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
            <button onClick={onSkipBreak}>Reprendre maintenant</button>
          </div>
        </div>
      )}

      {state.status === "done" && (
        <div className="ics-ask">
          <p className="ics-done">
            {state.winner === "home" ? homeName : awayName} l&apos;emporte{" "}
            {state.gamesWon.home}–{state.gamesWon.away}
          </p>
          <div className="ics-ask-row">
            <button onClick={onFinish} disabled={finishBusy} aria-busy={finishBusy || undefined}>
              {finishLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
