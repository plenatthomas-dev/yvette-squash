import { postAjax } from "./client";
import { normalize } from "./match";

// ============================================================================
//  LE ROSTER D'UNE ÉQUIPE (squashnet.fr), source PUBLIQUE.
//
//  Même point d'entrée que le reste (`index.php`), seul `ic_a` change : 393480
//  rend la fiche d'une équipe — son identité, ses calendriers, et LA LISTE DE
//  SES JOUEURS INSCRITS, avec pour chacun sa licence, son classement, son rang
//  et son rang mixte.
//
//  UN SEUL IDENTIFIANT : `teamid`. Ni `eventid`, ni `drawid`, ni `roundid` —
//  vérifié en appelant la section avec le seul `teamid` (fixture ci-jointe).
//  C'est l'exception au piège des quatre identifiants documenté dans
//  `docs/squashnet.md` : ici, l'équipe suffit à se désigner elle-même.
//
//  CE QUE ÇA CHANGE POUR LES ADVERSAIRES. Jusqu'ici, le classement d'un joueur
//  d'en face s'obtenait par RAPPROCHEMENT : chercher son nom au classement
//  fédéral, puis retenir la ligne si UNE SEULE collait au club (`match.ts`).
//  Ce chemin coûte une recherche par joueur, échoue sur une orthographe, et
//  rend un verdict « introuvable » qu'un capitaine ne peut pas distinguer d'un
//  silence de squashnet. Ici, la fédération DONNE la licence et le classement,
//  pour les joueurs qu'elle a elle-même inscrits dans l'équipe. Il n'y a plus
//  rien à rapprocher : une requête par équipe remplace huit recherches.
//
//  ⚠️ CE ROSTER EST CELUI DES INSCRITS, PAS DES ALIGNÉS. Un club inscrit son
//  effectif en début de saison ; qui joue tel soir n'en dépend pas. Un joueur
//  aligné contre nous et absent de cette liste EXISTE (mutation tardive,
//  inscription oubliée) — d'où la saisie libre, qui reste atteignable.
//
//  LE PARSING S'ACCROCHE AUX `data-label`, PAS AUX COLONNES, pour la raison
//  exposée dans `standings.ts` : une colonne insérée en tête décalerait tout un
//  parsing positionnel SANS RIEN CASSER de visible — on lirait le rang à la
//  place du rang mixte, et l'ordre des simples serait contrôlé sur un chiffre
//  faux mais crédible.
//
//  Tolère les guillemets simples ET doubles : squashnet a basculé tout son HTML
//  des uns aux autres le 2026-08-26 sans prévenir.
// ============================================================================

/** Action AJAX de la section « Fiche d'une équipe ». */
const ROSTER_ACTION = "393480";

/**
 * Le fragment n'a pas la forme attendue.
 *
 * DISTINCTE d'un roster vide, et la distinction est tout l'objet de cette classe : une équipe
 * inscrite sans joueur est un fait banal de début de saison, un rendu qui a changé est une
 * panne. Les confondre annoncerait au capitaine que l'équipe d'en face n'a inscrit personne —
 * exactement le contresens que `CalendarUnreadableError` évite déjà sur le calendrier.
 */
export class RosterUnreadableError extends Error {
  constructor(snTeamId: string) {
    super("roster illisible pour l'équipe " + snTeamId);
    this.name = "RosterUnreadableError";
  }
}

/** Un joueur inscrit dans une équipe, tel que la fédération le publie. */
export interface RosterPlayer {
  /** Nom fédéral, « POPULU AXEL » — famille puis prénom, en capitales. */
  name: string;
  /** « Mr. » / « Mme. », tel quel. Null si la colonne est vide. */
  gender: string | null;
  /** N° de licence, « 1404133H » ou « 0113258 ». */
  licence: string | null;
  /** Classement, « 4B », « NC ». */
  clt: string | null;
  /** Rang national dans son genre. */
  rang: number | null;
  /** Rang national MIXTE — celui qui départage les ex æquo à l'ordre des simples. */
  rangM: number | null;
  /** Date d'inscription dans l'équipe, « YYYY-MM-DD ». */
  registeredAt: string | null;
}

/** Une fiche d'équipe, réduite à ce qu'on en retient. */
export interface TeamRoster {
  /** L'identifiant demandé — celui du tableau lu, donc jamais celui d'une autre équipe. */
  snTeamId: string;
  /** Nom publié de l'ÉQUIPE, « Verrieres 2 » (numéro compris). */
  teamName: string | null;
  /** Sigle, « VERR2 ». */
  code: string | null;
  /** Nom du CLUB, « Squash club verrieres le buisson » — sans le numéro d'équipe. */
  club: string | null;
  /** Capitaine déclaré à la fédération. */
  captain: string | null;
  players: RosterPlayer[];
}

/**
 * Cette valeur a-t-elle la forme d'un roster ?
 *
 * Le roster est stocké en JSON dans une colonne texte et relu des semaines plus tard par un
 * écran et par une garde de composition. « JSON valide » ne suffit pas : un tableau d'un format
 * antérieur passe le `JSON.parse` et lève au rendu. On vérifie ce que les lecteurs lisent — le
 * nom, et les deux valeurs dont dépend l'ordre des simples.
 */
export function estRoster(v: unknown): v is TeamRoster {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.snTeamId !== "string" || !Array.isArray(r.players)) return false;
  return r.players.every((p) => {
    if (typeof p !== "object" || p === null) return false;
    const j = p as Record<string, unknown>;
    return (
      typeof j.name === "string" &&
      (j.clt === null || typeof j.clt === "string") &&
      (j.rangM === null || typeof j.rangM === "number")
    );
  });
}

/**
 * La clé d'identité d'un nom, INSENSIBLE À L'ORDRE DES MOTS.
 *
 * La fédération écrit « POPULU AXEL » (famille puis prénom) ; une feuille de match porte
 * « Axel Populu ». `normalize` seule les laisse distincts — elle plie la casse et les accents,
 * pas l'ordre. Sans cette clé, le roster n'enrichirait JAMAIS un nom déjà saisi : on afficherait
 * deux fois le même joueur au menu, l'un classé, l'autre pas, et l'ordre des simples resterait
 * invérifiable sur celui que le capitaine a choisi.
 *
 * Les jetons sont triés, donc « Jean Marie Dupont » et « Dupont Jean Marie » coïncident. Un
 * second prénom écrit d'un seul côté reste, lui, un autre joueur : on ne devine pas.
 */
export function nameKey(s: string): string {
  const n = normalize(s);
  return n ? n.split(" ").sort().join(" ") : "";
}

const TR = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const TD = /<td[^>]*data-label=["']([^"']*)["'][^>]*>([\s\S]*?)<\/td>/gi;

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
 * Un rang, ou null. Lecture STRICTE, reprise de `match.ts` : « NC » n'est pas 0, et un rang
 * commence à 1 — un zéro est une case vide déguisée, et le laisser passer placerait le joueur
 * EN TÊTE de l'ordre des simples, donc devant les mieux classés de son équipe.
 */
function rang(raw: string | undefined): number | null {
  const v = (raw ?? "").replace(/\s/g, "");
  if (!/^\d+$/.test(v)) return null;
  const n = Number.parseInt(v, 10);
  return n > 0 ? n : null;
}

/** Une valeur de cellule, ou null si elle est vide (jamais la chaîne vide, qui se teste mal). */
function txt(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v || null;
}

/**
 * « 22-09-2025 » → « 2025-09-22 ». Null si ce n'est pas une date.
 *
 * Le format ISO est celui de tout le dépôt (`Interclub.date`, `SquashnetRankingPoint.month`) :
 * il se trie comme du texte. Garder le format fédéral ferait trier septembre après octobre.
 */
function dateIso(raw: string | undefined): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((raw ?? "").trim());
  return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}

/** La table des joueurs porte l'identifiant de l'équipe : `<table id="players_161095">`. */
function tableJoueurs(html: string, snTeamId: string): string | null {
  const re = new RegExp(
    "<table[^>]*id=[\"']players_" + snTeamId + "[\"'][^>]*>[\\s\\S]*?</table>",
    "i",
  );
  return re.exec(html)?.[0] ?? null;
}

/**
 * L'identité de l'équipe, lue dans le tableau `info`.
 *
 * ⚠️ PAR `data-label`, COMME PARTOUT AILLEURS. Ce code appariait les intitulés `<th>` aux
 * valeurs `<td>` PAR POSITION, en affirmant que ce tableau n'en portait pas — ce que la fixture
 * jointe dément : ses cinq cellules ont toutes leur `data-label`. Et l'appariement se faisait
 * APRÈS avoir écarté les cases vides, si bien qu'un club sans site internet décalait la colonne
 * suivante : « Association » prenait la place de « Site internet », et le nom du CLUB — celui
 * sous lequel la fédération range les joueurs — devenait le nom de l'association suivante, ou
 * disparaissait avec le garde-fou de longueur. En silence, sur un club parfaitement ordinaire.
 */
function identite(html: string): Pick<TeamRoster, "teamName" | "code" | "club" | "captain"> {
  const vide = { teamName: null, code: null, club: null, captain: null };
  const table = /<table[^>]*id=["']info["'][^>]*>[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table) return vide;

  const par = new Map<string, string>();
  TD.lastIndex = 0;
  let td: RegExpExecArray | null;
  while ((td = TD.exec(table)) !== null) par.set(normalize(td[1].trim()), texte(td[2]));
  if (par.size === 0) return vide;

  return {
    teamName: txt(par.get("nom")),
    code: txt(par.get("sigle")),
    // « Association » porte le CLUB (« Squash club verrieres le buisson »), là où « Nom » porte
    // l'ÉQUIPE et son numéro (« Verrieres 2 »). C'est la distinction qui a coûté le bug des
    // équipes numérotées (`clubOfTeam`) : la fédération range ses joueurs sous le club.
    club: txt(par.get("association")),
    captain: txt(par.get("capitaine")),
  };
}

/**
 * Le roster, lu dans le fragment rendu par la fédération.
 *
 * ⚠️ LE TABLEAU EST CHOISI SUR L'IDENTIFIANT DEMANDÉ, jamais sur sa position. La fiche en
 * contient plusieurs (identité, un calendrier par poule, les joueurs), et surtout : rien ne
 * garantit que la fédération ait honoré NOTRE `teamid`. Elle l'ignore déjà ailleurs — c'est la
 * panne muette que `standings.ts` documente, où l'absence de `drawid` rend la division 1 dans
 * un tableau parfaitement crédible. Exiger `players_<teamid>` rend cette panne-là IMPOSSIBLE :
 * ou bien on lit les joueurs de l'équipe demandée, ou bien on ne lit rien.
 *
 * Jette `RosterUnreadableError` si ce tableau manque ; rend une liste vide s'il est là mais
 * sans ligne — une équipe inscrite sans joueur est un fait, pas une panne.
 */
export function parseTeamRoster(html: string, snTeamId: string): TeamRoster {
  const table = tableJoueurs(html, snTeamId);
  if (!table) throw new RosterUnreadableError(snTeamId);

  const players: RosterPlayer[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(table)) !== null) {
    const cells = new Map<string, string>();
    TD.lastIndex = 0;
    let td: RegExpExecArray | null;
    while ((td = TD.exec(tr[1])) !== null) cells.set(td[1].trim(), texte(td[2]));
    if (cells.size === 0) continue; // l'en-tête, en <th>

    const name = (cells.get("Nom Prénom") ?? "").trim();
    // Une ligne sans nom n'est pas un joueur partiel, c'est du bruit.
    if (!name) continue;

    players.push({
      name,
      gender: txt(cells.get("Genre")),
      licence: txt(cells.get("Licence")),
      clt: txt(cells.get("Classement")),
      rang: rang(cells.get("Rang")),
      rangM: rang(cells.get("RangM")),
      registeredAt: dateIso(cells.get("Date")),
    });
  }

  return { snTeamId, ...identite(html), players };
}

/**
 * Télécharge le roster d'une équipe. UNE requête, UN identifiant.
 *
 * Aucune authentification : la fiche d'équipe est publique, comme le reste de ce qu'on lit.
 * L'espacement des appels appartient à l'APPELANT (cf. `backfill.ts`) — une boucle sur les cinq
 * équipes d'une poule doit respirer entre deux, squashnet ne nous devant rien.
 */
export async function fetchTeamRoster(snTeamId: string): Promise<TeamRoster> {
  const html = await postAjax({
    ic_a: ROSTER_ACTION,
    mustache: "1",
    ic_ajax: "1",
    teamid: snTeamId,
  });
  return parseTeamRoster(html, snTeamId);
}
