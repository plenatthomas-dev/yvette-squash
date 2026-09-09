// ============================================================================
//  LA COURBE DE CLASSEMENT — géométrie et mise en forme, PURES et testées.
//
//  Un seul import, et PUR (`interclub-order`) : ce module est lu par la route
//  (qui trie et borne) comme par le composant (qui trace). Le calcul d'une
//  courbe est le genre de code qu'on ne sait relire qu'en le testant — et un axe
//  inversé au mauvais endroit produit un graphique parfaitement lisible qui
//  raconte l'inverse de la vérité.
//
//  DEUX MÉTRIQUES, ET TOUTES DEUX DESCENDENT QUAND ON PROGRESSE :
//
//   * la MOYENNE (« mean ») BAISSE quand on progresse. C'est le défaut, et la
//     seule des valeurs publiées qui bouge tous les mois ;
//   * le RANG MIXTE (« rangM ») baisse aussi — être 800e vaut mieux qu'être
//     2300e.
//
//  Leurs axes sont donc inversés tous les deux, pour que « ça monte » veuille dire
//  « ça progresse » sur les deux graphiques.
//
//  ⚠️ CE MODULE A LONGTEMPS AFFIRMÉ L'INVERSE POUR `mean` (« monte quand on
//  progresse »), et le disait jusque dans le libellé sous le sélecteur. C'était
//  faux, et mesuré comme tel sur le corpus réel le 2026-09-09 : sur 81 mesures, la
//  corrélation entre `mean` et `rangM` vaut **r = 1,000**, et les sept classements
//  observés s'ordonnent proprement en sens inverse de `mean` — 4B (le plus fort)
//  entre 1496 et 1659, 5D (le plus faible) entre 7240 et 9052. Les six changements
//  de classement de l'historique le confirment un par un : chaque montée
//  s'accompagne d'un `mean` qui BAISSE.
//
//  Ce que squashnet appelle « moyenne » n'est donc pas une moyenne de POINTS qu'on
//  accumulerait, mais une moyenne de RANG — d'où la corrélation parfaite. La courbe
//  des « Points » était en conséquence dessinée à l'envers : le joueur qui
//  progressait plongeait, et la colonne « évolution » mettait un moins devant sa
//  meilleure saison.
//
//  LE CLASSEMENT (« 5A ») N'EST PAS UNE MÉTRIQUE. Il change deux ou trois fois
//  dans une vie de joueur : sa courbe serait un trait plat. Il s'affiche à côté
//  du nom, et il sert de RÈGLE GRADUÉE derrière la courbe des points
//  (`frontieresClassement`) — mais il ne se trace pas lui-même.
// ============================================================================

import { classementPower, KNOWN_CLASSEMENTS } from "./interclub-order";

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

/**
 * Vrai si, pour cette métrique, un nombre plus GRAND vaut mieux.
 *
 * FAUX POUR LES DEUX, et ce n'est pas un oubli : `mean` suit `rangM` (cf. l'en-tête, r = 1,000
 * sur le corpus réel). La fonction est gardée plutôt que supprimée parce qu'elle NOMME la
 * question à chaque endroit qui en dépend — l'axe, le chemin, le signe de l'évolution — et
 * qu'une troisième métrique un jour ajoutée y répondrait peut-être autrement.
 */
export function plusGrandEstMieux(_m: Metrique): boolean {
  return false;
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

// ----------------------------------------------------------------------------
//  LES LIGNES DE PASSAGE D'UN CLASSEMENT À L'AUTRE
// ----------------------------------------------------------------------------

/** Une ligne horizontale : la moyenne de points où l'on bascule dans `clt`. */
export interface Frontiere {
  /**
   * Le classement que l'on ATTEINT en franchissant la ligne vers le haut — donc le plus fort
   * des deux qu'elle sépare. C'est l'étiquette qui répond à « il me manque combien pour passer
   * 5A ? », qui est la question qu'on se pose devant cet écran.
   */
  clt: string;
  /** La moyenne de points où on la place. */
  valeur: number;
}

/**
 * La pyramide du plus FAIBLE au plus fort, NC exclu.
 *
 * DÉRIVÉE de `KNOWN_CLASSEMENTS` et non recopiée : une liste jumelle se désynchroniserait le
 * jour où la fédération ajouterait un échelon, et la frontière disparaîtrait sans que rien ne
 * le signale. `KNOWN_CLASSEMENTS` est déjà ordonnée du plus faible au plus fort.
 */
const ECHELLE: readonly string[] = KNOWN_CLASSEMENTS.filter((c) => c !== "NC");

/**
 * Ces deux classements se suivent-ils dans la pyramide fédérale ?
 *
 * Lu dans `ECHELLE` plutôt que calculé sur `classementPower` : ce poids est un détail
 * d'implémentation de la comparaison (il saute de 1 à 22 entre « 1N » et « 2A »), et s'y fier
 * ferait dépendre l'adjacence d'un choix d'encodage.
 */
function sontAdjacents(bas: string, haut: string): boolean {
  const i = ECHELLE.indexOf(bas);
  const j = ECHELLE.indexOf(haut);
  return i >= 0 && j === i + 1;
}

/**
 * OÙ PASSE-T-ON DE « 5B » À « 5A » — déduit de nos propres mesures, jamais d'un barème écrit
 * en dur.
 *
 * ⚠️ CE MODULE NE CONNAÎT PAS LE BARÈME DE LA FÉDÉRATION, et n'a pas à l'inventer. Poser des
 * seuils au jugé donnerait un graphique parfaitement crédible et faux, du genre qui ne se
 * dément jamais : un joueur lirait « il me manque 200 points pour passer 5A » sur une ligne
 * sortie de nulle part.
 *
 * Ce qu'on a est suffisant : CHAQUE MESURE PORTE À LA FOIS le classement publié ce mois-là et
 * la moyenne qui l'a produit. Le corpus dit donc lui-même où sont les marches — la plus BASSE
 * moyenne jamais vue sous « 5B » et la plus HAUTE jamais vue sous « 5A » encadrent la frontière,
 * et on la pose au milieu. Plus le club accumule de mois, plus l'encadrement se resserre : la
 * règle graduée s'affine toute seule, sans que personne n'ait à la tenir à jour.
 *
 * ⚠️ LE SENS COMPTE, ET IL EST CONTRE-INTUITIF : un `mean` PLUS PETIT est un MEILLEUR
 * classement (cf. l'en-tête du module). La première version de cette fonction lisait le corpus
 * dans l'autre sens et n'a jamais tracé la moindre ligne — chaque paire échouait à son test
 * d'encadrement, en silence, exactement comme une catégorie qui se chevauche.
 *
 * TROIS REFUS, chacun pour ne pas dessiner une ligne qu'on ne sait pas placer :
 *
 *  1. **Rien pour le RANG.** Un classement ne correspond à aucun rang fixe — le rang dépend du
 *     champ, donc la « ligne du 5A » se déplacerait tous les mois. Une ligne qui bouge sur un
 *     axe qui bouge n'est plus un repère. `metrique !== "mean"` ⇒ aucune frontière.
 *  2. **Rien entre deux catégories qui SE CHEVAUCHENT.** Si une moyenne vue sous « 5A » est
 *     inférieure à une moyenne vue sous « 5B », le corpus se contredit (barème révisé entre
 *     deux saisons, classement corrigé à la main, mesure fausse). On saute cette frontière-là
 *     plutôt que d'en inventer une au milieu du désordre.
 *  3. **Rien entre deux échelons NON ADJACENTS.** Si le club n'a que des « 5C » et des « 5A »,
 *     la marche entre les deux en recouvre DEUX : la tracer et l'étiqueter « 5A » ferait lire
 *     un seuil unique là où il y en a deux, et placerait le premier au hasard.
 *
 * `NC` est écarté : ce n'est pas un échelon mais l'absence d'échelon, et la fédération ne
 * l'ordonne pas (cf. `isNC`). Une « frontière du NC » n'aurait pas de sens.
 *
 * Le calcul porte sur TOUTES les séries et TOUS leurs mois, jamais sur la seule sélection à
 * l'écran : une frontière est une propriété de l'échelle fédérale, pas de qui l'on regarde.
 * Cocher un joueur de plus ne doit pas déplacer les repères sous ses pieds.
 */
export function frontieresClassement(series: HistorySeries[], metrique: Metrique): Frontiere[] {
  if (metrique !== "mean") return [];

  // Étendue de moyenne observée sous chaque classement, avec son rang dans la pyramide.
  const vus = new Map<string, { power: number; min: number; max: number }>();
  for (const s of series) {
    for (const p of s.points) {
      if (p.mean === null) continue;
      const clt = p.clt.trim().toUpperCase();
      const power = classementPower(clt);
      // `null` = classement que la fédération n'a pas (faute de saisie) ; `Infinity` = NC.
      if (power === null || !Number.isFinite(power)) continue;
      const e = vus.get(clt);
      if (!e) {
        vus.set(clt, { power, min: p.mean, max: p.mean });
      } else {
        if (p.mean < e.min) e.min = p.mean;
        if (p.mean > e.max) e.max = p.mean;
      }
    }
  }

  // Du plus FAIBLE au plus fort : `classementPower` décroît quand on monte (1I vaut 0).
  const echelons = [...vus.entries()]
    .map(([clt, e]) => ({ clt, ...e }))
    .sort((a, b) => b.power - a.power);

  const out: Frontiere[] = [];
  for (let i = 0; i + 1 < echelons.length; i++) {
    const bas = echelons[i];
    const haut = echelons[i + 1];
    if (!sontAdjacents(bas.clt, haut.clt)) continue;
    // `bas` est le classement le plus FAIBLE, donc celui dont les moyennes sont les plus
    // GRANDES. Sa plus petite moyenne doit rester au-dessus de la plus grande de `haut`, sans
    // quoi les deux catégories se chevauchent : le corpus se contredit, on ne tranche pas.
    if (!(bas.min > haut.max)) continue;
    out.push({ clt: haut.clt, valeur: (bas.min + haut.max) / 2 });
  }
  return out;
}

/**
 * Combien on accepte d'ÉLARGIR l'échelle pour faire entrer une marche, en fraction de l'étendue
 * déjà affichée.
 *
 * Ni zéro ni l'infini, et les deux extrêmes sont mauvais pour la même raison — ils rendent
 * l'écran muet, l'un en cachant la marche, l'autre en aplatissant la courbe :
 *
 *  * à ZÉRO, l'écran s'ouvrant sur UN joueur (c'est son parti pris) cadre sur les quelques
 *    dizaines de points que ce joueur a parcourus en un an. Aucune frontière ne tombe dans une
 *    fenêtre aussi étroite tant qu'il n'a pas changé de classement — donc aucune ligne, jamais,
 *    précisément dans la vue par défaut ;
 *  * SANS BORNE, on ferait entrer une marche située à dix fois l'étendue du joueur. L'échelle
 *    se dilaterait d'autant et sa courbe deviendrait un trait plat : on aurait remplacé une
 *    information par un repère qu'il n'atteindra pas cette saison.
 *
 * Un quart de l'étendue déjà parcourue dit donc quelque chose d'assez juste : « la marche est à
 * portée de ce que tu as bougé récemment ». Un joueur au milieu de sa catégorie ne voit rien,
 * et c'est correct — il n'y a rien à lui dire.
 */
const MARGE_MARCHE = 0.25;

/**
 * L'échelle élargie, si peu, pour qu'une marche PROCHE entre dans le cadre.
 *
 * On ne bouge que le côté où une frontière attend, et jamais au-delà de `MARGE_MARCHE`. Les
 * bornes rendues restent celles de TOUTES les courbes affichées (cf. `ordonnee`) : c'est
 * toujours la même échelle pour tout le monde, juste un peu plus large.
 *
 * ⚠️ Étendue NULLE (un joueur, une seule mesure) : on ne s'accroche à rien, donc on n'élargit
 * rien. Le cas a son état dédié à l'écran, et un quart de zéro ne ferait entrer aucune marche
 * tout en risquant un cadre dégénéré.
 */
export function bornesAvecMarches(
  bornes: { min: number; max: number },
  frontieres: Frontiere[],
): { min: number; max: number } {
  const etendue = bornes.max - bornes.min;
  if (etendue <= 0) return bornes;
  const marge = etendue * MARGE_MARCHE;

  let min = bornes.min;
  let max = bornes.max;
  for (const f of frontieres) {
    if (f.valeur < bornes.min && f.valeur >= bornes.min - marge) min = Math.min(min, f.valeur);
    if (f.valeur > bornes.max && f.valeur <= bornes.max + marge) max = Math.max(max, f.valeur);
  }
  return { min, max };
}
