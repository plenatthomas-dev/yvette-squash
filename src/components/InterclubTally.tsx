"use client";

import { runningTally, type RunningTally, type TallyMatch } from "@/lib/interclub";

// LE COMPTEUR D'AVANCE, PENDANT LA RENCONTRE.
//
// À quatre simples, la moitié des issues possibles est un nul, et un nul vaut DEUX points de
// classement ou UN selon l'average de jeux — puis, à jeux égaux, selon l'average de points. La
// rencontre peut donc se décider au point près, sur le dernier échange du dernier match.
//
// Ce que l'écran montrait jusqu'ici — le score en matchs, et le détail simple par simple — ne
// permet pas de le savoir : il faut additionner de tête les jeux et les points de quatre
// matchs, dont un en cours. Cette ligne fait l'addition, et la refait à chaque rafraîchissement
// du direct.
//
// ⚠️ ELLE DIT AUSSI QUAND ELLE NE SERT À RIEN, et c'est la moitié de son intérêt. Un average
// affiché en permanence se lirait comme un enjeu permanent ; or il ne départage QUE sur un nul.
// Quand le nul n'est plus atteignable — parce que l'écart est trop grand, ou simplement parce
// que la parité l'interdit à un simple de la fin —, les chiffres restent affichés mais la
// phrase le dit, et rien ne sort du gris. Laisser croire qu'on joue pour deux jeux d'average
// alors que la rencontre est déjà gagnée aux matchs serait pire que de ne rien afficher.
//
// AUCUNE REQUÊTE PROPRE : tout se calcule sur la charge utile déjà reçue (`/api/interclub/live`
// pour le panneau du direct, la fiche pour le détail). Le compteur suit donc la cadence du
// direct sans rien lui coûter — `PRODUCT.md` proscrit la requête de plus sur un chemin chaud.

/** Un écart signé, « +3 » / « -2 ». Le signe est l'information ; sans lui, tout se vaut. */
const signe = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** « 3 jeux », « 1 jeu ». */
const jeux = (n: number) => `${n} jeu${Math.abs(n) > 1 ? "x" : ""}`;

/**
 * Ce que le compte veut dire, en une phrase — et lequel des deux averages est en jeu.
 *
 * L'ordre des cas est celui du règlement : on ne parle d'average que si le nul est encore
 * possible, et on ne parle de points que si les jeux sont à égalité. Sortir un chiffre de son
 * ordre le ferait passer pour décisif alors qu'il ne le serait pas.
 */
export function tallyPhrase(t: RunningTally): {
  text: string;
  decisive: "games" | "rallies" | null;
} {
  if (t.settled === "win") {
    return { text: "Victoire acquise aux matchs — 3 pts au classement.", decisive: null };
  }
  if (t.settled === "loss") {
    return { text: "Défaite acquise aux matchs.", decisive: null };
  }
  if (!t.drawReachable) {
    // Deux raisons possibles, une seule phrase : dans les deux cas l'average ne décide rien, et
    // c'est la seule chose que le lecteur a besoin de savoir.
    return { text: "Le nul n'est plus atteignable : l'average ne départagera rien.", decisive: null };
  }

  const nul = `${t.drawAt}–${t.drawAt}`;
  const dj = t.games.home - t.games.away;
  if (dj !== 0) {
    return {
      text:
        dj > 0
          ? `Un ${nul} nous donnerait le nul gagné (E+, 2 pts) : ${jeux(dj)} d'avance.`
          : `Un ${nul} nous laisserait le nul perdu (E-, 1 pt) : ${jeux(-dj)} de retard.`,
      decisive: "games",
    };
  }

  if (!t.rallies) {
    return {
      text: `Un ${nul} se jouerait aux points — le détail d'un simple manque, le total est inconnu.`,
      decisive: null,
    };
  }
  const dp = t.rallies.home - t.rallies.away;
  if (dp === 0) {
    return { text: `Un ${nul} que rien ne départagerait pour l'instant.`, decisive: "rallies" };
  }
  return {
    text:
      dp > 0
        ? `Jeux à égalité : un ${nul} se jouerait aux points, et nous en avons ${dp} de plus (E+, 2 pts).`
        : `Jeux à égalité : un ${nul} se jouerait aux points, et il en manque ${-dp} (E-, 1 pt).`,
    decisive: "rallies",
  };
}

/**
 * `null` tant que RIEN n'a été joué. Une rencontre à 0–0 partout n'a pas d'avance, et une ligne
 * de zéros sous un simple qui n'a pas commencé ne fait qu'occuper la place.
 */
export default function InterclubTally({
  matchCount,
  matches,
  compact = false,
}: {
  matchCount: number;
  matches: readonly TallyMatch[];
  /** Vrai dans le panneau du direct, où la carte est déjà dense. */
  compact?: boolean;
}) {
  const t = runningTally(matchCount, matches);
  const joue =
    t.games.home + t.games.away > 0 || (t.rallies ? t.rallies.home + t.rallies.away > 0 : false);
  if (!joue) return null;

  const { text, decisive } = tallyPhrase(t);
  const dj = t.games.home - t.games.away;
  const dp = t.rallies ? t.rallies.home - t.rallies.away : null;

  return (
    <div className={`ic-tally${compact ? " is-compact" : ""}`}>
      <p className="ic-tally-row">
        <span className="ic-tally-label">Avance</span>
        <span className={`ic-tally-avg${decisive === "games" ? " is-decisive" : ""}`}>
          jeux {t.games.home}–{t.games.away}{" "}
          <span className="ic-tally-diff">({signe(dj)})</span>
        </span>
        {/* Le total des points ne s'affiche que s'il est COMPLET : partiel, il désignerait le
            mauvais vainqueur d'un nul, et c'est exactement le chiffre qu'on vient lire. */}
        {t.rallies ? (
          <span className={`ic-tally-avg${decisive === "rallies" ? " is-decisive" : ""}`}>
            points {t.rallies.home}–{t.rallies.away}{" "}
            <span className="ic-tally-diff">({signe(dp as number)})</span>
          </span>
        ) : (
          <span
            className="ic-tally-avg"
            title="Un simple est saisi sans son détail jeu par jeu : le total des points serait partiel."
          >
            points indisponibles
          </span>
        )}
      </p>
      <p className="ic-tally-say">{text}</p>
    </div>
  );
}
