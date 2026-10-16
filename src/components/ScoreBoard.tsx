"use client";

import type { ReactNode } from "react";
import { useCloseRequest } from "@/lib/useCloseRequest";
import {
  ballPoint,
  resolveColor,
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
  onToggleBox,
  onUndo,
  onSkipBreak,
  onBack,
  onFinish,
  finishLabel = "Terminer",
  finishBusy = false,
  first = "home",
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
  /** L'engagement : qui sert. Le carré, lui, se propose (cf. `startServe`). */
  onFirstServe: (side: Side) => void;
  /** Appui FACULTATIF sur « D? » / « G? » : le serveur change de carré. */
  onToggleBox: () => void;
  onUndo: () => void;
  onSkipBreak: () => void;
  onBack: () => void;
  onFinish: () => void;
  finishLabel?: string;
  finishBusy?: boolean;
  /**
   * Le côté AFFICHÉ en premier — case de gauche (ou du haut), premier chiffre de chaque jeu,
   * première ligne de « Qui engage ? ». `home` par défaut.
   *
   * L'interclub y met L'ÉQUIPE QUI REÇOIT, à la demande du club (2026-10-09) : c'est l'ordre de
   * la feuille de match. Seul l'AFFICHAGE bouge — les rappels gardent le sens de la donnée
   * (`onPoint("home")` est toujours notre joueur), si bien que le journal des points, la synchro
   * et l'annulation ignorent tout de cet ordre.
   */
  first?: Side;
}) {
  // Le retour d'Android fait ce que fait « ← Retour » : l'appelant enregistre, puis quitte.
  useCloseRequest(onBack);
  const second: Side = first === "home" ? "away" : "home";
  /** Une paire de valeurs d'un jeu, dans l'ordre affiché. */
  const paire = (g: { home: number; away: number }) => (first === "home" ? [g.home, g.away] : [g.away, g.home]);
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
    const serving = state.serving === who && state.servingBox !== null;
    const droite = state.servingBox === "right";
    return (
      <div className="ics-cell" key={who}>
        <button
          className="ics-side"
          style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
          onClick={() => onPoint(who)}
          disabled={attendServeur || state.status === "done" || remaining > 0}
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
          {/* Bas-gauche : les jeux gagnés. Le coin bas-droit revient au carré de service, qui
              vit HORS de ce bouton (cf. plus bas). */}
          <span className="ics-foot">
            <span className="ics-won">
              <span className="sr-only">Jeux gagnés : </span>
              {won} jeu{won > 1 ? "x" : ""}
            </span>
          </span>
        </button>
        {/* LE CARRÉ DE SERVICE, À CÔTÉ DU SERVEUR — « D? » proposé, « D » réglementaire.
            L'appui est FACULTATIF : il ne sert qu'à corriger, et ne bloque jamais le point
            suivant. Le carré se réclamait autrefois par un panneau à chaque reprise de service,
            et c'est ce panneau que le club a jugé trop contraignant (2026-10-16).

            Un bouton FRÈRE de la case, posé par-dessus son coin, et non un enfant : un bouton
            dans un bouton n'est pas du HTML valide, et l'appui remonterait au point. Il reprend
            l'encre calculée du maillot, comme tout ce qui est peint sur la case. */}
        {serving && (
          <button
            type="button"
            className={`ics-box${state.boxProposed ? " is-proposed" : ""}`}
            style={c ? { color: c.fg } : undefined}
            onClick={onToggleBox}
            aria-label={`${name} sert ${droite ? "à droite" : "à gauche"}${
              state.boxProposed ? " (proposé)" : ""
            } — toucher pour servir ${droite ? "à gauche" : "à droite"}`}
            title="Changer de carré"
          >
            {droite ? "D" : "G"}
            {state.boxProposed && <span aria-hidden="true">?</span>}
          </button>
        )}
      </div>
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
            {paire(g)[0]}-{paire(g)[1]}
            {i < state.games.length - 1 ? " · " : ""}
          </span>
        ))}
      </p>

      <div className="ics-board">
        {side(first)}
        {side(second)}
      </div>

      {/* Premier service du match : on ne demande QUE qui sert. Le carré se propose sur la
          case du serveur (« D? »), et se corrige d'un appui si besoin. */}
      {state.serving === null && state.status !== "done" && (
        <div className="ics-ask">
          <p>Qui engage&nbsp;?</p>
          <div className="ics-ask-row">
            {[first, second].map((who) => (
              <button key={who} onClick={() => onFirstServe(who)}>
                {who === "home" ? homeName : awayName} sert
              </button>
            ))}
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
            {/* Les jeux du VAINQUEUR d'abord : « l'emporte 1–3 » se lisait comme une défaite
                dès que le vainqueur était le second joueur. */}
            {state.winner === "home" ? homeName : awayName} l&apos;emporte{" "}
            {Math.max(state.gamesWon.home, state.gamesWon.away)}–
            {Math.min(state.gamesWon.home, state.gamesWon.away)}
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
