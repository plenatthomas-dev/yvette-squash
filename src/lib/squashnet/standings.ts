import { postAjax } from "./client";

// ============================================================================
//  CLASSEMENT D'UNE POULE (squashnet.fr), source PUBLIQUE.
//
//  Même point d'entrée que le reste (`index.php`), seul `ic_a` change : 394242
//  rend la section « Classement et rencontres » d'un événement par équipes.
//
//  TROIS IDENTIFIANTS POUR CETTE REQUÊTE, ET ILS NE SE VALENT PAS :
//
//    eventid  l'épreuve  (« Critérium IDF Équipes Hommes 2025-26 »)
//    drawid   la DIVISION (47760 = Hommes 4)
//    roundid  la POULE    (370138 = poule IVD)
//
//  L'ANCRAGE D'UNE ÉQUIPE EN COMPTE QUATRE — ces trois-là plus `teamid`, qui ne
//  sert pas ici (la fédération l'ignore sur cette section) mais dit, à l'écran,
//  laquelle des lignes rendues est la nôtre.
//
//  ⚠️ SANS `drawid`, LE `roundid` EST IGNORÉ et la fédération rend la division 1.
//  Mesuré : en demandant la poule IVD (Hommes 4) sans préciser la division, on
//  reçoit le classement de Squash Pyramides, Montigny et consorts — un tableau
//  parfaitement bien formé, où notre équipe ne figure pas. Aucune erreur, aucun
//  502 : la même panne muette que sur le calendrier, en pire, parce qu'ici le
//  résultat A L'AIR juste. C'est pourquoi la route d'admin exige les quatre
//  identifiants ensemble ou aucun.
//
//  LE PARSING S'ACCROCHE AUX `data-label`, PAS AUX COLONNES. Le tableau en
//  compte dix-huit, dans un ordre que rien ne nous garantit ; chaque cellule
//  porte son intitulé (`<td data-label="J+">`), et c'est infiniment plus sûr
//  que de compter jusqu'à treize. Une colonne insérée en tête déplacerait tout
//  un parsing positionnel SANS RIEN CASSER de visible : on lirait les jeux à la
//  place des matchs, et le classement affiché serait faux mais crédible.
//
//  Tolère les guillemets simples ET doubles : squashnet a basculé tout son HTML
//  des uns aux autres le 2026-08-26 sans prévenir, et le classement a cassé net.
// ============================================================================

/** Action AJAX de la section « Classement et rencontres ». */
const STANDINGS_ACTION = "394242";

/** Un couple gagné / perdu et son écart, tel que la fédération le publie. */
export interface StandingTally {
  won: number;
  lost: number;
  diff: number;
}

/** Une ligne du classement d'une poule. */
export interface StandingRow {
  /** Rang publié. On le lit, on ne le recalcule pas : le départage appartient à la ligue. */
  rank: number;
  /** Nom publié, « Squash de l'Yvette ». */
  name: string;
  /** Code court, « YVETTE ». Null si la fédération n'en met pas. */
  code: string | null;
  /**
   * `data-teamid` de la ligne. C'est LUI qui dit si c'est nous, jamais le nom : deux clubs
   * d'un même réseau portent des libellés qui ne diffèrent que par un chiffre, et une équipe
   * renommée en cours de saison ferait disparaître notre surlignage sans prévenir.
   */
  snTeamId: string | null;
  points: number;
  played: number;
  won: number;
  /** Nul GAGNÉ à l'average (`E+` au classement fédéral) : 2 points. */
  drawWon: number;
  /** Nul PERDU à l'average (`E-`) : 1 point. */
  drawLost: number;
  lost: number;
  /**
   * La colonne « P » du tableau fédéral, lue TELLE QUELLE — et dont l'interprétation
   * n'est PAS établie.
   *
   * On la nomme « pénalités » par analogie, sans preuve : sur notre poule elle n'explique pas
   * les points (UCPA Meudon affiche V=1, P=0 et Pts=1, alors qu'une victoire vaut 3), et
   * `standings.test.ts` le constate noir sur blanc. Deux équipes finissent d'ailleurs sous le
   * barème sans que cette colonne en porte la trace — l'une à -3.
   *
   * Elle n'est affichée nulle part, et c'est délibéré tant que sa signification n'est pas
   * vérifiée : montrer un chiffre qu'on ne sait pas lire, sous un intitulé qu'on a deviné,
   * ferait conclure quelque chose de faux à qui le regarde. On la conserve parce qu'un
   * classement relu dans six mois se compare à ce qui a été capté, pas à ce qu'on en a retenu.
   */
  penalties: number;
  /** Matchs, jeux, points de jeu. */
  matches: StandingTally;
  games: StandingTally;
  rallies: StandingTally;
}

/**
 * Cette valeur a-t-elle la forme d'une ligne de classement ?
 *
 * Le classement est stocké en JSON dans une colonne texte, et relu des mois plus tard par un
 * écran qui lit `nous.matches.won` sans garde. « JSON valide » ne suffit donc pas : un tableau
 * d'un FORMAT ANTÉRIEUR passe le `JSON.parse`, passe l'`Array.isArray`, et lève au rendu — où
 * il n'y a pas d'error boundary pour rattraper quoi que ce soit. On vérifie ce que l'écran
 * lit, pas plus : le rang, le nom, et les trois agrégats.
 */
export function estLigneClassement(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const tally = (t: unknown) =>
    typeof t === "object" &&
    t !== null &&
    ["won", "lost", "diff"].every((k) => typeof (t as Record<string, unknown>)[k] === "number");
  return (
    typeof r.rank === "number" &&
    typeof r.name === "string" &&
    tally(r.matches) &&
    tally(r.games) &&
    tally(r.rallies)
  );
}

const TR = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const TD = /<td[^>]*data-label=["']([^"']*)["'][^>]*>([\s\S]*?)<\/td>/gi;
const TEAM_ID = /data-teamid=["'](\d+)["']/i;

function texte(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Un entier, ou 0. Les écarts sont signés (« -495 » existe).
 *
 * Le MOINS TYPOGRAPHIQUE (U+2212) est ramené au tiret ASCII avant le filtrage. Sans cela il
 * tombait avec le reste de la ponctuation : « −3 » devenait « 3 », et une équipe pénalisée
 * sous zéro remontait de six places. La fixture n'a que de l'ASCII aujourd'hui — mais un total
 * négatif est précisément ce que `standings.test.ts` dit vouloir protéger, et une correction
 * copiée depuis un traitement de texte suffit à faire entrer ce caractère.
 */
function entier(v: string | undefined): number {
  const n = Number.parseInt((v ?? "").replace(/−/g, "-").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function tally(cells: Map<string, string>, prefixe: string): StandingTally {
  const won = entier(cells.get(`${prefixe}+`));
  const lost = entier(cells.get(`${prefixe}-`));
  // L'écart est publié, mais il est aussi déductible : on préfère la soustraction, qui ne
  // peut pas contredire les deux colonnes affichées juste à côté.
  return { won, lost, diff: won - lost };
}

/**
 * Le classement, lu dans le fragment rendu par la fédération.
 *
 * Ne rend QUE les lignes exploitables : une ligne sans rang ni nom n'est pas un classement
 * partiel, c'est du bruit.
 *
 * LE TABLEAU EST CHOISI SUR SON CONTENU, ET NON SUR SA POSITION. On prenait le PREMIER `<table>`
 * venu, en affirmant que les rencontres « suivent dans le même fragment » — affirmation
 * qu'aucune fixture n'appuie (elle n'en contient qu'un seul) et qu'aucun test ne vérifie. Une
 * légende, un encart ou un tableau de règlement intercalé au-dessus aurait rendu un classement
 * FAUX sans la moindre erreur : le pire des résultats, parce qu'il s'affiche.
 *
 * Le critère est celui qui compte : le premier tableau dont on tire au moins une ligne de
 * classement. Un tableau qui n'en est pas un n'en produit aucune, par construction — les
 * cellules sont indexées sur `data-label`, et il faut un rang ET un nom d'équipe.
 */
export function parseStandings(html: string): StandingRow[] {
  for (const table of html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)) {
    const rows = lignesDe(table[0]);
    if (rows.length > 0) return rows;
  }
  return [];
}

/** Les lignes de classement d'UN tableau — vide si ce tableau n'en est pas un. */
function lignesDe(table: string): StandingRow[] {
  const rows: StandingRow[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(table)) !== null) {
    const brut = tr[1];
    const cells = new Map<string, string>();
    TD.lastIndex = 0;
    let td: RegExpExecArray | null;
    while ((td = TD.exec(brut)) !== null) cells.set(td[1].trim(), texte(td[2]));
    if (cells.size === 0) continue; // l'en-tête, en <th>

    const rank = entier(cells.get("#"));
    const libelle = cells.get("Equipe") ?? "";
    if (!rank || !libelle) continue;

    // « Squash de l'Yvette (YVETTE) » — le code court est entre parenthèses, à la fin.
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(libelle);
    const name = (m ? m[1] : libelle).trim();

    // La fédération complète les poules impaires par une équipe fictive « Non Joue », qui
    // occupe un rang et n'a jamais joué. L'afficher ferait croire à un club de plus.
    if (/^non\s*jou/i.test(name)) continue;

    const idm = TEAM_ID.exec(brut);
    rows.push({
      rank,
      name,
      code: m ? m[2].trim() || null : null,
      snTeamId: idm ? idm[1] : null,
      points: entier(cells.get("Pts")),
      played: entier(cells.get("J")),
      won: entier(cells.get("V")),
      drawWon: entier(cells.get("E+")),
      drawLost: entier(cells.get("E-")),
      lost: entier(cells.get("D")),
      penalties: entier(cells.get("P")),
      matches: tally(cells, "M"),
      games: tally(cells, "J"),
      rallies: tally(cells, "P"),
    });
  }
  return rows;
}

/**
 * Télécharge le classement d'une poule.
 *
 * Les trois identifiants sont OBLIGATOIRES, et c'est délibéré : `drawId` optionnel rendrait
 * silencieusement le classement d'une autre division, tableau bien formé à l'appui.
 */
export async function fetchStandings(
  eventId: string,
  drawId: string,
  roundId: string,
): Promise<StandingRow[]> {
  const html = await postAjax({
    ic_a: STANDINGS_ACTION,
    mustache: "1",
    ic_ajax: "1",
    eventid: eventId,
    drawid: drawId,
    roundid: roundId,
  });
  return parseStandings(html);
}
