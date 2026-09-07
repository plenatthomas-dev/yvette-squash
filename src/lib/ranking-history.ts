// ============================================================================
//  LA COURBE DE CLASSEMENT — géométrie et mise en forme, PURES et testées.
//
//  Aucun import : ce module est lu par la route (qui trie et borne) comme par le
//  composant (qui trace). Le calcul d'une courbe est le genre de code qu'on ne
//  sait relire qu'en le testant — et un axe inversé au mauvais endroit produit
//  un graphique parfaitement lisible qui raconte l'inverse de la vérité.
//
//  DEUX MÉTRIQUES, ET ELLES NE SE LISENT PAS DANS LE MÊME SENS :
//
//   * la MOYENNE DE POINTS (« mean ») monte quand on progresse. C'est le défaut,
//     et la seule des valeurs publiées qui bouge tous les mois ;
//   * le RANG MIXTE (« rangM ») DESCEND quand on progresse — être 800e vaut
//     mieux qu'être 2300e. Son axe est donc inversé, pour que « ça monte » veuille
//     dire la même chose sur les deux graphiques. Sans cette inversion, le joueur
//     le plus en forme du club aurait la courbe qui plonge.
//
//  LE CLASSEMENT (« 5A ») N'EST PAS UNE MÉTRIQUE. Il change deux ou trois fois
//  dans une vie de joueur : sa courbe serait un trait plat. Il s'affiche à côté
//  du nom, il ne se trace pas.
// ============================================================================

/** Une mesure, telle que la fédération l'a publiée ce mois-là. */
export interface HistoryPoint {
  /** Période fédérale, « YYYY-MM-DD » — la valeur exacte du sélecteur de squashnet. */
  month: string;
  clt: string;
  rang: number | null;
  rangM: number | null;
  mean: number | null;
}

/** Un joueur et ses mesures, du plus ancien mois au plus récent. */
export interface HistorySeries {
  id: string;
  kind: "member" | "guest";
  name: string;
  /** Équipe interclub, quand il y en a une. Sert à filtrer, pas à tracer. */
  team: string | null;
  points: HistoryPoint[];
}

/** Ce qu'on trace. Voir l'en-tête : les deux ne se lisent pas dans le même sens. */
export type Metrique = "mean" | "rangM";

/** Vrai si, pour cette métrique, un nombre plus GRAND vaut mieux. */
export function plusGrandEstMieux(m: Metrique): boolean {
  return m === "mean";
}

const MOIS_COURTS = [
  "janv.",
  "févr.",
  "mars",
  "avril",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];

/**
 * « 2026-07-07 » → « juil. 26 ».
 *
 * Découpage à la main plutôt que `toLocaleDateString` : la valeur est une date SANS FUSEAU, et
 * la passer par `new Date()` la ramène à minuit UTC — soit, pour un lecteur à l'ouest de
 * Greenwich, la veille. Un « 2026-07-01 » affiché « juin 26 » décalerait toute la courbe d'un
 * mois, et le décalage ne se verrait que la moitié de l'année.
 */
export function moisLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  const i = Number.parseInt(m[2], 10) - 1;
  return `${MOIS_COURTS[i] ?? m[2]} ${m[1].slice(2)}`;
}

/** Les mois de `months` compris dans [from, to]. Bornes vides = pas de borne de ce côté. */
export function moisDansPlage(months: string[], from: string, to: string): string[] {
  return months.filter((m) => (!from || m >= from) && (!to || m <= to));
}

/**
 * Les valeurs d'un joueur, alignées sur `months` — `null` là où il n'a pas été mesuré.
 *
 * L'alignement est ce qui rend deux joueurs comparables : sans lui, celui qui a trois trous
 * dans l'année verrait ses points s'étaler sur toute la largeur, à côté de son coéquipier
 * mesuré tous les mois, et les deux courbes ne parleraient pas du même temps.
 */
export function valeurs(serie: HistorySeries, months: string[], metrique: Metrique): (number | null)[] {
  const parMois = new Map(serie.points.map((p) => [p.month, p]));
  return months.map((m) => parMois.get(m)?.[metrique] ?? null);
}

/** Min et max sur TOUTES les séries, ou null si rien n'est mesurable. */
export function bornesValeurs(
  series: HistorySeries[],
  months: string[],
  metrique: Metrique,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of valeurs(s, months, metrique)) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Le cadre de tracé, en unités du viewBox. */
export interface Cadre {
  w: number;
  h: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

/** L'abscisse du i-ème mois. Un mois seul se pose au milieu plutôt qu'à gauche. */
export function abscisse(i: number, n: number, c: Cadre): number {
  const large = c.w - c.padL - c.padR;
  return c.padL + (n <= 1 ? large / 2 : (large * i) / (n - 1));
}

/**
 * L'ordonnée d'une valeur. `bornes` vient de TOUTES les séries affichées, jamais d'une seule :
 * une échelle par joueur donnerait à chacun la même belle pente, et rendrait la comparaison —
 * qui est tout l'objet de l'écran — impossible.
 */
export function ordonnee(
  v: number,
  bornes: { min: number; max: number },
  metrique: Metrique,
  c: Cadre,
): number {
  const haut = c.h - c.padT - c.padB;
  const etendue = bornes.max - bornes.min;
  // Toutes les valeurs égales : une ligne au milieu. Diviser par zéro donnerait un NaN, et un
  // NaN dans un attribut `d` fait disparaître la courbe sans le moindre message.
  const part = etendue === 0 ? 0.5 : (v - bornes.min) / etendue;
  // Axe INVERSÉ pour le rang : cf. l'en-tête. « Vers le haut » doit vouloir dire « progresse »
  // sur les deux métriques.
  return c.padT + haut * (plusGrandEstMieux(metrique) ? 1 - part : part);
}

/**
 * Le `d` d'un `<path>`, en SEGMENTS séparés par les trous.
 *
 * Un mois non mesuré coupe le trait au lieu d'être enjambé : relier janvier à mars par-dessus
 * février dessinerait une progression continue là où on n'a rien observé. Le trou se voit,
 * c'est le but.
 */
export function chemin(
  vals: (number | null)[],
  bornes: { min: number; max: number },
  metrique: Metrique,
  c: Cadre,
): string {
  const morceaux: string[] = [];
  let ouvert = false;
  vals.forEach((v, i) => {
    if (v === null) {
      ouvert = false;
      return;
    }
    const x = abscisse(i, vals.length, c).toFixed(1);
    const y = ordonnee(v, bornes, metrique, c).toFixed(1);
    morceaux.push(`${ouvert ? "L" : "M"}${x} ${y}`);
    ouvert = true;
  });
  return morceaux.join(" ");
}

/**
 * L'évolution entre la PREMIÈRE et la DERNIÈRE mesure connue, exprimée dans le sens du progrès :
 * positive = a progressé, quelle que soit la métrique.
 *
 * Le rang change donc de signe (passer 2300e → 1800e est un gain de 500), sans quoi la colonne
 * « évolution » afficherait un moins devant la meilleure saison du club.
 *
 * Null s'il n'y a pas DEUX mesures : un joueur mesuré une seule fois n'a pas d'évolution, et
 * afficher « 0 » ferait croire à une stagnation observée.
 */
export function progression(
  serie: HistorySeries,
  months: string[],
  metrique: Metrique,
): number | null {
  const vals = valeurs(serie, months, metrique).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const delta = vals[vals.length - 1] - vals[0];
  return plusGrandEstMieux(metrique) ? delta : -delta;
}

/** La dernière mesure connue d'un joueur sur la plage, ou null. */
export function dernierPoint(serie: HistorySeries, months: string[]): HistoryPoint | null {
  const dans = new Set(months);
  const gardes = serie.points.filter((p) => dans.has(p.month));
  return gardes.length ? gardes[gardes.length - 1] : null;
}

/**
 * Palette des courbes. Des teintes DISTINCTES et non un dégradé : les séries sont des joueurs,
 * pas des paliers d'une même grandeur, et rien ne les ordonne. Douze suffisent à un club (au
 * treizième joueur affiché, on recommence — la légende reste, elle, sans ambiguïté).
 *
 * Elles sont écrites en dur ici plutôt que puisées dans les tokens de DESIGN.md : celui-ci
 * définit les couleurs du PRODUIT (accent, danger, sobre), pas une échelle catégorielle, et
 * détourner l'accent en « couleur du joueur n°1 » lui ferait dire deux choses.
 */
export const COULEURS = [
  "#2f7f4f",
  "#b4462a",
  "#3563a8",
  "#8a5a1c",
  "#7a3f8f",
  "#177a7a",
  "#a03060",
  "#5c6b12",
  "#2b5f8a",
  "#8f4b16",
  "#4a4fa0",
  "#6f7030",
];

export const couleurDe = (i: number) => COULEURS[i % COULEURS.length];
