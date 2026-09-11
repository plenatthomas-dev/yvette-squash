import { postAjax } from "./client";
import { normalize } from "./match";
import {
  TR,
  attr,
  cellule,
  cellules,
  dateIso,
  heure,
  rang,
  texte,
  txt,
  valeur,
} from "./html";

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

/** L'issue d'une rencontre, telle que la fédération la qualifie POUR L'ÉQUIPE DEMANDÉE. */
export type TieResult = "won" | "lost" | "draw" | "notPlayed";

/**
 * Une rencontre du calendrier de l'équipe, telle que sa fiche la publie.
 *
 * ⚠️ TOUT EST DIT DU POINT DE VUE DE L'ÉQUIPE DEMANDÉE : « Gagné » veut dire qu'ELLE a gagné, et
 * `scoreFor` est SON total. La feuille de match (`tie.ts`), elle, parle en « A » et « B » sans
 * privilégier personne — c'est la raison d'être des deux lectures.
 */
export interface TeamTie {
  /** `tieid` fédéral — la clé de la feuille de match (`ic_a=394248`). */
  snTieId: string;
  /** Date de la rencontre, « YYYY-MM-DD ». */
  date: string | null;
  /** Heure, « HH:MM », lue de `data-order` quand la fédération la publie. */
  time: string | null;
  /** Le TOUR tel qu'affiché (« 1 »), SANS le « J » de nos journées. */
  round: string | null;
  /** `teamid` fédéral de l'adversaire — la clé de son roster. */
  opponentTeamId: string | null;
  /** Nom publié de l'équipe adverse. */
  opponentName: string | null;
  /** Club hôte, tel que publié. Vide sur une rencontre non planifiée. */
  venue: string | null;
  result: TieResult | null;
  /**
   * Simples gagnés par l'équipe demandée, et par son adversaire.
   *
   * ⚠️ NULL, ET NON ZÉRO, SUR UNE RENCONTRE NON JOUÉE. La fédération publie « 0 / 0 » sur toutes
   * les journées à venir : le lire comme un score ferait annoncer un 0-0 (donc, à quatre simples,
   * un NUL parfaitement plausible) sur une rencontre qui n'a pas eu lieu. C'est la distinction
   * « vide » / « illisible » du dépôt, appliquée à « pas encore joué ».
   */
  scoreFor: number | null;
  scoreAgainst: number | null;
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
  /**
   * Le calendrier de l'équipe, TOUTES PHASES CONFONDUES, et surtout : avec le `tieid` de chaque
   * rencontre. C'est le seul endroit public où il figure — le calendrier de l'épreuve
   * (`ic_a=393986`, `calendar.ts`) ne le publie pas. Sans lui, aucune feuille de match n'est
   * atteignable.
   */
  ties: TeamTie[];
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
  // ⚠️ `ties` N'EST PAS EXIGÉ, et c'est délibéré. Tous les rosters rangés avant que ce champ
  // n'existe en sont dépourvus : l'exiger déclarerait ILLISIBLES, du jour au lendemain, tous les
  // rosters déjà en base — les menus d'adversaires se videraient d'un coup, et le seul remède
  // serait un rafraîchissement manuel équipe par équipe. `lireRoster` comble le manque par une
  // liste vide, ce qui est la vérité : on n'a pas ces rencontres, on ne les a pas lues.
  if (r.ties !== undefined && !Array.isArray(r.ties)) return false;
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

  // Intitulés NORMALISÉS : la fédération écrit « Nom » ici et « NOM » ailleurs, et un accent
  // de plus ferait disparaître le club en silence.
  const par = new Map(cellules(table).map((c) => [normalize(c.label), texte(c.html)]));
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
 * Les issues telles que la fédération les écrit, du point de vue de l'équipe consultée.
 *
 * Les quatre valeurs sont MESURÉES sur la fiche de référence (« Gagné » ×13, « Perdu » ×8, « Non
 * joué » ×3) sauf « Nul », qui ne pouvait pas y figurer : à cinq simples, l'égalité est
 * impossible. Elle le devient à quatre — ce que joue notre D4 depuis 2026-27. Le libellé est
 * donc anticipé, et un libellé inconnu rend `null` plutôt que de se ranger dans la case voisine.
 */
const ISSUES: ReadonlyMap<string, TieResult> = new Map([
  ["gagne", "won"],
  ["perdu", "lost"],
  ["nul", "draw"],
  ["non joue", "notPlayed"],
]);

/** « 4 / 1 » → [4, 1]. Null si ce n'est pas un score (un lien vide, « - », un libellé). */
function score(raw: string): [number, number] | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw.trim());
  return m ? [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)] : null;
}

/**
 * Les rencontres de l'équipe, lues dans TOUS les tableaux `round_*` de sa fiche.
 *
 * ⚠️ IL Y EN A PLUSIEURS, et les confondre serait une erreur de lecture. La fiche de référence en
 * porte deux : « Hommes 4 - Poule A » (le championnat, 18 rencontres) et « Hommes 4 - Poule IVC »
 * (la phase finale, 6 de plus). Une équipe joue donc bien les deux, et leurs TOURS SE RÉPÈTENT —
 * il y a deux « Tour 1 », à huit mois d'écart.
 *
 * D'où la règle que tout le rapprochement en aval respecte : LA CLÉ EST LA DATE, jamais le tour
 * ni l'adversaire. Le même adversaire revient (Verrieres 3 aux tours 1 et 10), les tours ne
 * suivent même pas l'ordre des dates (le tour 15 se joue avant le 13), et deux phases les
 * renumérotent chacune depuis 1. La date, elle, est ce que `Interclub.date` porte déjà.
 */
function parseTies(html: string): TeamTie[] {
  const ties: TeamTie[] = [];
  // Tous les tableaux de calendrier, dans l'ordre de la page. `[\s\S]*?` s'arrête au premier
  // `</table>` : ces tableaux n'en contiennent pas d'imbriqué (vérifié sur la fiche de référence).
  const TABLES = /<table[^>]*id=["']round_\d+["'][^>]*>[\s\S]*?<\/table>/gi;
  let table: RegExpExecArray | null;
  while ((table = TABLES.exec(html)) !== null) {
    TR.lastIndex = 0;
    let tr: RegExpExecArray | null;
    while ((tr = TR.exec(table[0])) !== null) {
      const c = cellules(tr[1]);
      if (c.length === 0) continue; // l'en-tête, en <th>

      const cellScore = cellule(c, "Score");
      // LE `tieid` EST LA RAISON D'ÊTRE DE CETTE LECTURE : une ligne qui n'en porte pas ne mène
      // à aucune feuille de match, donc n'a rien à apporter. On la laisse plutôt que d'en faire
      // une entrée sans clé, qu'un rapprochement ultérieur prendrait pour une rencontre connue.
      const snTieId = cellScore ? attr(cellScore.attrs + " " + cellScore.html, "data-tieid") : null;
      if (!snTieId) continue;

      const cellDate = cellule(c, "Date");
      const cellAdv = cellule(c, "Adversaire");
      const issue = ISSUES.get(normalize(valeur(c, "Résultat"))) ?? null;
      // `data-order` porte « 2025-10-09 20:00:00 » — déjà triable, et SEULE source de l'heure :
      // la cellule visible ne montre que le jour.
      const ordre = cellDate ? attr(cellDate.attrs, "data-order") : null;
      const brut = score(valeur(c, "Score"));

      ties.push({
        snTieId,
        // `data-order` est déjà en ISO (« 2025-10-09 20:00:00 ») ; la cellule visible, elle,
        // est au format fédéral et ne porte PAS l'heure. On prend l'attribut quand il est là.
        date: /^\d{4}-\d{2}-\d{2}/.test(ordre ?? "")
          ? (ordre as string).slice(0, 10)
          : dateIso(valeur(c, "Date")),
        time: heure(ordre),
        round: txt(valeur(c, "Tour")),
        opponentTeamId: cellAdv ? attr(cellAdv.html, "data-teamid") : null,
        opponentName: txt(texte(cellAdv?.html ?? "")),
        venue: txt(valeur(c, "Lieu")),
        result: issue,
        // ⚠️ LE « 0 / 0 » D'UNE RENCONTRE NON JOUÉE N'EST PAS UN SCORE. La fédération le publie
        // sur toutes les journées à venir ; le garder ferait annoncer un résultat nul sur une
        // rencontre qui n'a pas eu lieu — et, à quatre simples, ce nul serait crédible.
        scoreFor: issue === "notPlayed" ? null : (brut?.[0] ?? null),
        scoreAgainst: issue === "notPlayed" ? null : (brut?.[1] ?? null),
      });
    }
  }
  return ties;
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
    const c = cellules(tr[1]);
    if (c.length === 0) continue; // l'en-tête, en <th>

    const name = valeur(c, "Nom Prénom");
    // Une ligne sans nom n'est pas un joueur partiel, c'est du bruit.
    if (!name) continue;

    players.push({
      name,
      gender: txt(valeur(c, "Genre")),
      licence: txt(valeur(c, "Licence")),
      clt: txt(valeur(c, "Classement")),
      rang: rang(valeur(c, "Rang")),
      rangM: rang(valeur(c, "RangM")),
      registeredAt: dateIso(valeur(c, "Date")),
    });
  }

  return { snTeamId, ...identite(html), players, ties: parseTies(html) };
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
