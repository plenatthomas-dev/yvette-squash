import { postAjax } from "./client";

// ============================================================================
//  CLASSEMENT D'UNE POULE (squashnet.fr), source PUBLIQUE.
//
//  Même point d'entrée que le reste (`index.php`), seul `ic_a` change : 394242
//  rend la section « Classement et rencontres » d'un événement par équipes.
//
//  TROIS IDENTIFIANTS, ET ILS NE SE VALENT PAS :
//
//    eventid  l'épreuve  (« Critérium IDF Équipes Hommes 2025-26 »)
//    drawid   la DIVISION (47760 = Hommes 4)
//    roundid  la POULE    (370138 = poule IVD)
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
  /** Pénalités. Une équipe peut finir avec un total négatif — vu en 2025-26. */
  penalties: number;
  /** Matchs, jeux, points de jeu. */
  matches: StandingTally;
  games: StandingTally;
  rallies: StandingTally;
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

/** Un entier, ou 0. Les écarts sont signés (« -495 » existe). */
function entier(v: string | undefined): number {
  const n = Number.parseInt((v ?? "").replace(/[^\d-]/g, ""), 10);
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
 * partiel, c'est du bruit. Les tableaux annexes (les rencontres, qui suivent dans le même
 * fragment) sont ignorés — seul le PREMIER tableau est le classement.
 */
export function parseStandings(html: string): StandingRow[] {
  const table = /<table[^>]*>[\s\S]*?<\/table>/i.exec(html);
  if (!table) return [];

  const rows: StandingRow[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(table[0])) !== null) {
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
