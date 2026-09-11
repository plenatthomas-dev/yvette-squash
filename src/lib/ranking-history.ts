// ============================================================================
//  LA COURBE DE CLASSEMENT — géométrie et mise en forme, PURES et testées.
//
//  Un seul import, et PUR (`interclub-order`) : ce module est lu par la route
//  (qui trie et borne) comme par le composant (qui trace). Le calcul d'une
//  courbe est le genre de code qu'on ne sait relire qu'en le testant — et un axe
//  inversé au mauvais endroit produit un graphique parfaitement lisible qui
//  raconte l'inverse de la vérité.
//
//  UNE SEULE MÉTRIQUE : LE RANG MIXTE (« rangM »). Il BAISSE quand on progresse —
//  être 800e vaut mieux qu'être 2300e — donc son axe est inversé, pour que « ça
//  monte » veuille dire « ça progresse ».
//
//  ⚠️ IL Y EN A EU DEUX, ET C'ÉTAIT UNE DE TROP. L'écran proposait au choix le rang
//  ou la « moyenne de points » (`mean`), présentée comme montant quand on progresse.
//  Mesuré sur le corpus réel le 2026-09-09 : sur 81 mesures, la corrélation entre
//  `mean` et `rangM` vaut **r = 1,000**. Ce n'est pas une seconde grandeur, c'est la
//  MÊME à un lissage près — ce que squashnet appelle « moyenne » est une moyenne de
//  RANG, pas de points qu'on accumulerait. Les sept classements observés s'ordonnent
//  d'ailleurs en sens inverse de `mean` (4B, le plus fort, entre 1496 et 1659 ; 5D,
//  le plus faible, entre 7240 et 9052), et les six changements de classement de
//  l'historique le confirment un par un.
//
//  La courbe des « Points » était donc dessinée à L'ENVERS — le joueur qui
//  progressait plongeait, et la colonne « évolution » mettait un moins devant sa
//  meilleure saison — et proposait au lecteur un choix entre deux vues du même
//  chiffre. Le sélecteur a été retiré, `mean` reste stocké et n'est plus tracé.
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
export function valeurs(serie: HistorySeries, months: string[]): (number | null)[] {
  const parMois = new Map(serie.points.map((p) => [p.month, p]));
  return months.map((m) => parMois.get(m)?.rangM ?? null);
}

/** Min et max sur TOUTES les séries, ou null si rien n'est mesurable. */
export function bornesValeurs(
  series: HistorySeries[],
  months: string[],
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of valeurs(s, months)) {
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
  c: Cadre,
): number {
  const haut = c.h - c.padT - c.padB;
  const etendue = bornes.max - bornes.min;
  // Toutes les valeurs égales : une ligne au milieu. Diviser par zéro donnerait un NaN, et un
  // NaN dans un attribut `d` fait disparaître la courbe sans le moindre message.
  const part = etendue === 0 ? 0.5 : (v - bornes.min) / etendue;
  // Axe INVERSÉ : cf. l'en-tête. Le rang baisse quand on progresse, et « vers le haut » doit
  // vouloir dire « progresse ».
  return c.padT + haut * part;
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
    const y = ordonnee(v, bornes, c).toFixed(1);
    morceaux.push(`${ouvert ? "L" : "M"}${x} ${y}`);
    ouvert = true;
  });
  return morceaux.join(" ");
}

/**
 * L'évolution entre la PREMIÈRE et la DERNIÈRE mesure connue, exprimée dans le sens du progrès :
 * positive = a progressé.
 *
 * Null s'il n'y a pas DEUX mesures : un joueur mesuré une seule fois n'a pas d'évolution, et
 * afficher « 0 » ferait croire à une stagnation observée.
 */
export function progression(
  serie: HistorySeries,
  months: string[],
): number | null {
  const vals = valeurs(serie, months).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  // Le signe est INVERSÉ : passer 2300e → 1800e est un gain de 500, et la colonne « évolution »
  // afficherait sans cela un moins devant la meilleure saison du club.
  return -(vals[vals.length - 1] - vals[0]);
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
 * LES DEUX MÉTRIQUES Y ONT DROIT, et c'est un revirement assumé. Cette fonction a d'abord
 * refusé net de tracer quoi que ce soit sur le rang, au motif qu'« un classement ne correspond
 * à aucun rang fixe, le rang dépend du champ ». Le raisonnement supposait `mean` et `rangM`
 * indépendants. Ils ne le sont pas : r = 1,000 sur le corpus réel (cf. l'en-tête). Une
 * frontière est donc exactement aussi stable — ou aussi instable — dans une échelle que dans
 * l'autre, et c'est le test de chevauchement ci-dessous qui tranche, dans les deux cas, sur
 * mesure plutôt que sur principe.
 *
 * DEUX REFUS, chacun pour ne pas dessiner une ligne qu'on ne sait pas placer :
 *
 *  1. **Rien entre deux catégories qui SE CHEVAUCHENT.** Si une valeur vue sous « 5A » est
 *     moins bonne qu'une valeur vue sous « 5B », le corpus se contredit (barème révisé entre
 *     deux saisons, classement corrigé à la main, mesure fausse). On saute cette frontière-là
 *     plutôt que d'en inventer une au milieu du désordre.
 *  2. **Rien entre deux échelons NON ADJACENTS.** Si le club n'a que des « 5C » et des « 5A »,
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
export function frontieresClassement(series: HistorySeries[]): Frontiere[] {
  // Étendue observée sous chaque classement, DANS LA MÉTRIQUE DEMANDÉE, avec son rang dans la
  // pyramide. Les deux métriques se lisent dans le même sens (plus petit = meilleur), donc le
  // reste du calcul est rigoureusement identique.
  const vus = new Map<string, { power: number; min: number; max: number }>();
  for (const s of series) {
    for (const p of s.points) {
      const v = p.rangM;
      if (v === null) continue;
      const clt = p.clt.trim().toUpperCase();
      const power = classementPower(clt);
      // `null` = classement que la fédération n'a pas (faute de saisie) ; `Infinity` = NC.
      if (power === null || !Number.isFinite(power)) continue;
      const e = vus.get(clt);
      if (!e) {
        vus.set(clt, { power, min: v, max: v });
      } else {
        if (v < e.min) e.min = v;
        if (v > e.max) e.max = v;
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

/** Une zone du graphique où l'on est dans `clt`, bornée dans l'échelle affichée. */
export interface Bande {
  clt: string;
  /** Bornes en valeurs, déjà rognées sur l'échelle visible. */
  min: number;
  max: number;
  /**
   * Position dans la pyramide, 0 pour le plus FAIBLE des échelons affichés. C'est ce qui dose
   * la teinte : une rampe ordonnée, jamais une couleur par catégorie tirée au hasard.
   */
  rang: number;
  /** Combien de bandes en tout — pour répartir la rampe sans la coder en dur à l'écran. */
  total: number;
}

/**
 * LES ZONES ENTRE LES MARCHES, prêtes à peindre.
 *
 * Les frontières disent OÙ l'on change de classement ; les bandes disent DANS QUOI on se
 * trouve entre deux d'entre elles. C'est ce que le fond colore, et c'est ce qui répond d'un
 * coup d'œil à « je suis dans quoi, là ? » sans lire une étiquette.
 *
 * ⚠️ UNE RAMPE ORDONNÉE, PAS UNE COULEUR PAR CATÉGORIE. Les classements forment une échelle
 * (5D < 5C < … < 4B), et une teinte par échelon — bleu pour 5B, orange pour 5A — détruirait
 * cet ordre : le lecteur devrait apprendre une légende au lieu de LIRE la pente. `rang` et
 * `total` donnent donc à l'écran de quoi doser une seule teinte du plus clair (échelon le plus
 * faible) au plus soutenu, ce qui se lit sans rien apprendre.
 *
 * La bande du haut et celle du bas s'étendent jusqu'au bord du cadre : on ne connaît pas leur
 * frontière extérieure (aucune mesure au-delà), et laisser un liseré neutre au bord ferait
 * croire à une zone sans classement.
 */
export function bandesClassement(
  frontieres: Frontiere[],
  bornes: { min: number; max: number },
): Bande[] {
  if (frontieres.length === 0) return [];

  // Rognées à l'échelle visible, et triées du MEILLEUR au moins bon (valeur croissante).
  //
  // ⚠️ BORNES INCLUSES, exactement comme le filtre des lignes à l'écran. Une comparaison
  // STRICTE laissait ces deux-là diverger dans le cas le plus courant : `bornesAvecMarches`
  // élargit l'échelle JUSQU'À la frontière, donc `f.valeur === bornes.min` en sortie — le trait
  // se dessinait, et le fond restait vide. Mesuré sur le corpus réel : la moitié des joueurs
  // qui voyaient une ligne n'avaient aucune bande.
  const dedans = frontieres
    .filter((f) => f.valeur >= bornes.min && f.valeur <= bornes.max)
    .sort((a, b) => a.valeur - b.valeur);
  if (dedans.length === 0) return [];

  const zones: { clt: string; min: number; max: number }[] = [];
  // Au-dessus de la meilleure frontière visible : on EST dans le classement qu'elle nomme.
  zones.push({ clt: dedans[0].clt, min: bornes.min, max: dedans[0].valeur });
  for (let i = 0; i < dedans.length; i++) {
    // Entre deux frontières : le classement est celui de la SUIVANTE dans l'ordre des valeurs,
    // c'est-à-dire l'échelon immédiatement plus faible.
    const bas = i + 1 < dedans.length ? dedans[i + 1].valeur : bornes.max;
    const clt = i + 1 < dedans.length ? dedans[i + 1].clt : echelonSousLe(dedans[i].clt);
    if (clt === null) continue;
    zones.push({ clt, min: dedans[i].valeur, max: bas });
  }

  // Les zones D'ÉPAISSEUR NULLE sautent : une frontière posée pile sur le bord du cadre (le cas
  // normal après `bornesAvecMarches`) ouvrirait au-dessus d'elle une zone haute de zéro pixel,
  // invisible mais comptée — elle décalerait toute la rampe de teintes d'un cran.
  const utiles = zones.filter((z) => z.max > z.min);

  // `rang` compte depuis le bas (l'échelon le plus faible), donc depuis la dernière zone.
  const total = utiles.length;
  return utiles.map((z, i) => ({ ...z, rang: total - 1 - i, total }));
}

/**
 * L'échelon juste EN DESSOUS de celui-ci dans la pyramide, ou `null` s'il n'y en a pas.
 *
 * Sert à nommer la bande du bas : sous la dernière frontière visible, on est dans le
 * classement d'un cran plus faible que celui qu'elle fait atteindre. `null` (« 5D », le plus
 * bas) fait taire la bande plutôt que de lui inventer un nom — NC n'est pas un échelon.
 */
function echelonSousLe(clt: string): string | null {
  const i = ECHELLE.indexOf(clt);
  return i > 0 ? ECHELLE[i - 1] : null;
}
