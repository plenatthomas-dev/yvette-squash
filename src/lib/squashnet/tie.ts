import { postAjax } from "./client";
import {
  TR,
  attr,
  cellules,
  dateIso,
  entier,
  heure,
  rang,
  texte,
  txt,
  valeur,
  type Cellule,
} from "./html";

// ============================================================================
//  LA FEUILLE DE MATCH OFFICIELLE D'UNE RENCONTRE (squashnet.fr), PUBLIQUE.
//
//  `ic_a=394248&tieid=<tieid>` rend la feuille telle que la ligue la publie :
//  qui a joué contre qui, à quel rang, le score jeu par jeu, et le total de la
//  rencontre. C'est LE DOCUMENT QUI FAIT FOI — celui contre lequel notre propre
//  relevé peut être confronté.
//
//  OÙ TROUVER LE `tieid`. Nulle part ailleurs que sur la fiche d'équipe
//  (`roster.ts`, `ic_a=393480`), qui le porte sur chaque ligne de son
//  calendrier. Le calendrier de l'ÉPREUVE (`ic_a=393986`, `calendar.ts`) ne le
//  publie pas : c'est pour cela que la lecture d'une feuille de match commence
//  toujours par la fiche de NOTRE équipe.
//
//  ⚠️ « A » ET « B » NE SONT PAS « NOUS » ET « EUX ». La ligue numérote les deux
//  côtés d'une rencontre sans privilégier personne, et rien ne dit que A soit le
//  receveur — sur la rencontre de référence, A est bien l'équipe qui reçoit,
//  mais une seule mesure ne fait pas une règle. Ce module ne tranche donc PAS :
//  il rend les deux côtés avec leur SIGLE, et laisse l'appelant reconnaître le
//  sien. Décider ici ferait afficher un 4-1 gagné sur une rencontre perdue.
//
//  ⚠️ ET LES INTITULÉS DE COLONNES SONT DES DONNÉES. Les deux colonnes de
//  joueurs s'appellent « A:VERR2 » et « B:VERR3 » — le sigle de chaque équipe
//  est DANS l'intitulé, donc il change à chaque rencontre. On ne peut pas les
//  coder en dur ; on reconnaît le préfixe « A: » / « B: », et le reste est le
//  sigle. C'est la seule entorse — apparente — à l'ancrage sur `data-label`, et
//  elle est en réalité le contraire : c'est la position qui serait fausse ici.
// ============================================================================

/** Action AJAX de la section « Feuille de match d'une rencontre ». */
const TIE_ACTION = "394248";

/**
 * Le fragment n'est pas une feuille de match lisible.
 *
 * Même doctrine que `RosterUnreadableError` : une rencontre sans aucun simple saisi est un FAIT
 * (elle n'a pas encore été jouée), un rendu qu'on ne sait plus lire est une PANNE. Les confondre
 * ferait dire « la ligue n'a rien saisi » là où c'est nous qui ne savons plus lire — et le
 * capitaine irait relancer un adversaire qui a pourtant tout saisi.
 */
export class TieUnreadableError extends Error {
  constructor(snTieId: string, raison: string) {
    super("feuille de match illisible pour la rencontre " + snTieId + " : " + raison);
    this.name = "TieUnreadableError";
  }
}

/** Un joueur tel qu'il figure sur la feuille de match. */
export interface TiePlayer {
  /** Nom fédéral, « POPULU AXEL » — famille puis prénom, en capitales. */
  name: string;
  /**
   * Identifiant fédéral d'INSCRIPTION (`data-regiid`), la clé de sa fiche (`ic_a=393477`).
   *
   * ⚠️ CE N'EST PAS UNE LICENCE. Il identifie l'inscription d'un joueur dans une épreuve, pas le
   * joueur : le même joueur en porte un autre dans une autre épreuve. Le rapprochement avec le
   * roster se fait donc sur le NOM (`nameKey`), pas sur cette valeur.
   */
  regiid: string | null;
  /** Classement au moment de la rencontre, « 4D ». */
  clt: string | null;
  /** Rang national dans son genre, tel que publié CE SOIR-LÀ. */
  rang: number | null;
  /** Rang national mixte, idem. */
  rangM: number | null;
}

/** Un simple de la rencontre, tel que la ligue le publie. */
export interface TieLine {
  /** L'intitulé du simple, « Homme 1 » — l'ordre fédéral, déjà dans le bon sens. */
  label: string;
  /** Le joueur du côté A, ou null si la case est vide (simple non saisi, ou forfait). */
  a: TiePlayer | null;
  b: TiePlayer | null;
  /**
   * Le score, TEL QUEL : « 11-6 11-3 8-11 11-0 ».
   *
   * Gardé en texte BRUT, et non découpé en jeux. On ne sait pas encore ce que la ligue y écrit
   * sur un forfait ou une blessure (aucune fixture n'en montre) : découper maintenant, c'est
   * décider à l'aveugle qu'un « WO » est un jeu perdu 0-0. Le texte, lui, se réaffiche sans
   * mentir, et les comptes de jeux sont publiés à côté.
   */
  score: string | null;
  /**
   * Qui a gagné ce simple, selon la classe `winner` que la ligue pose sur la case du vainqueur.
   * Null = aucun des deux côtés ne la porte, donc simple non joué ou non tranché.
   */
  winner: "A" | "B" | null;
  gamesA: number | null;
  gamesB: number | null;
  pointsA: number | null;
  pointsB: number | null;
}

/** Le total d'une rencontre, tel que la ligue l'additionne elle-même. */
export interface TieTotals {
  /** Simples gagnés de chaque côté — le score de la rencontre. */
  matchesA: number | null;
  matchesB: number | null;
  gamesA: number | null;
  gamesB: number | null;
  pointsA: number | null;
  pointsB: number | null;
}

/** Une feuille de match, réduite à ce qu'on en retient. */
export interface TieSheet {
  /** L'identifiant demandé. */
  snTieId: string;
  /** Sigle de l'équipe du côté A (« VERR2 »), lu dans l'intitulé de sa colonne. */
  codeA: string | null;
  codeB: string | null;
  /** « Hommes 4 ». */
  division: string | null;
  /** « Poule A ». */
  group: string | null;
  /** La JOURNÉE, « J1 » — au format de `Interclub.round`, et non celui de la fiche d'équipe. */
  round: string | null;
  venue: string | null;
  /** « YYYY-MM-DD ». */
  date: string | null;
  /** « HH:MM ». */
  time: string | null;
  lines: TieLine[];
  /**
   * Le total publié, ou null s'il n'y a pas de ligne de total.
   *
   * ⚠️ LU, JAMAIS RECALCULÉ. Recompter les `winner` donnerait un second chiffre, et c'est
   * précisément ce qu'on ne veut pas : tout l'objet de cette lecture est de dire CE QUE LA LIGUE
   * PUBLIE, pour le confronter à notre relevé. Un total que nous aurions calculé nous-mêmes ne
   * confronterait plus rien.
   */
  totals: TieTotals | null;
}

/**
 * « POPULU AXEL (4D  - 2021  - 2107) » → le joueur et ses trois valeurs.
 *
 * Les parenthèses sont le séparateur, et les espaces y sont doublés dans le rendu fédéral.
 * Une case sans joueur rend null — c'est le cas d'un simple non saisi.
 */
function joueur(cell: Cellule | undefined): TiePlayer | null {
  if (!cell) return null;
  const brut = texte(cell.html);
  if (!brut) return null;

  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(brut);
  const name = (m ? m[1] : brut).trim();
  if (!name) return null;

  // Les trois valeurs entre parenthèses, séparées par des tirets. Une feuille ancienne pourrait
  // n'en porter que le classement : on lit ce qui est là, sans exiger les trois.
  const parts = (m?.[2] ?? "").split("-").map((p) => p.trim());
  return {
    name,
    regiid: attr(cell.html, "data-regiid"),
    clt: txt(parts[0]),
    rang: rang(parts[1]),
    rangM: rang(parts[2]),
  };
}

/** La case porte-t-elle la marque du vainqueur ? */
function gagnant(cell: Cellule | undefined): boolean {
  return /(?:^|\s)winner(?:\s|$)/i.test(attr(cell?.attrs ?? "", "class") ?? "");
}

/**
 * La première cellule dont l'intitulé commence par ce préfixe, et le reste de l'intitulé.
 *
 * C'est le mécanisme qui remplace un `data-label` codé en dur, puisque le sigle de l'équipe EST
 * l'intitulé. Recherché dans l'ordre de la ligne : deux équipes de même sigle ne s'effaceraient
 * donc pas l'une l'autre, là où une carte en perdrait une.
 */
function parPrefixe(cs: readonly Cellule[], prefixe: string): { cell: Cellule; code: string } | null {
  const cell = cs.find((c) => c.label.startsWith(prefixe));
  return cell ? { cell, code: cell.label.slice(prefixe.length).trim() } : null;
}

/**
 * La feuille de match, lue dans le fragment rendu par la fédération.
 *
 * ⚠️ VÉRIFIE QUE C'EST BIEN LA RENCONTRE DEMANDÉE, quand le fragment le permet. Le tableau des
 * simples s'appelle `table_matchs` pour toutes les rencontres — contrairement au roster, dont la
 * table porte l'identifiant de l'équipe (`players_<teamid>`) et rend donc la confusion
 * impossible. Ici, le seul témoin est l'appel à `setUrl(...tieid=…)` que la page émet en pied.
 * Quand il est là et qu'il désigne une AUTRE rencontre, on jette : servir la feuille d'une autre
 * rencontre comme si c'était la nôtre est exactement la panne muette que tout ce module évite.
 * Quand il n'y est pas, on ne peut rien vérifier — et on le dit ici plutôt que de le laisser
 * croire.
 *
 * Jette `TieUnreadableError` si le tableau des simples manque ou si ses colonnes de joueurs ne
 * s'identifient pas. Rend une feuille SANS LIGNE si le tableau est là mais vide — une rencontre
 * non encore saisie est un fait, pas une panne.
 */
export function parseTieSheet(html: string, snTieId: string): TieSheet {
  const ids = [...html.matchAll(/tieid=(\d+)/gi)].map((m) => m[1]);
  if (ids.length > 0 && !ids.includes(snTieId)) {
    throw new TieUnreadableError(snTieId, "le fragment porte la rencontre " + ids[0]);
  }

  const tableMatchs = /<table[^>]*id=["']table_matchs["'][^>]*>[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!tableMatchs) throw new TieUnreadableError(snTieId, "tableau des simples absent");

  const infos = /<table[^>]*id=["']table_infos["'][^>]*>[\s\S]*?<\/table>/i.exec(html)?.[0] ?? "";
  const ci = cellules(infos);
  const quand = valeur(ci, "Date prévue");

  const lines: TieLine[] = [];
  let totals: TieTotals | null = null;
  let codeA: string | null = null;
  let codeB: string | null = null;

  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(tableMatchs)) !== null) {
    const c = cellules(tr[1]);
    if (c.length === 0) continue; // l'en-tête, en <th>

    const a = parPrefixe(c, "A:");
    const b = parPrefixe(c, "B:");
    // Le sigle est publié sur CHAQUE ligne : on retient le premier vu, il ne change pas.
    codeA ??= a ? txt(a.code) : null;
    codeB ??= b ? txt(b.code) : null;

    const matchesA = entier(valeur(c, "Matchs A"));
    const matchesB = entier(valeur(c, "Matchs B"));
    const gamesA = entier(valeur(c, "Jeux A"));
    const gamesB = entier(valeur(c, "Jeux B"));
    const pointsA = entier(valeur(c, "Points A"));
    const pointsB = entier(valeur(c, "Points B"));

    // LA LIGNE DE TOTAL SE RECONNAÎT À SON INTITULÉ VIDE, pas à sa position : elle est en queue
    // de tableau aujourd'hui, et rien ne garantit qu'elle y reste. La prendre pour un simple
    // ajouterait « 4-1 » à la liste des matchs — un cinquième simple, avec ses deux joueurs
    // vides, que l'écran afficherait comme un match non saisi.
    const label = valeur(c, "Match");
    if (!label) {
      // Un seul total par feuille : le premier trouvé fait foi (il n'y en a qu'un, mesuré).
      totals ??= { matchesA, matchesB, gamesA, gamesB, pointsA, pointsB };
      continue;
    }

    lines.push({
      label,
      a: joueur(a?.cell),
      b: joueur(b?.cell),
      score: txt(valeur(c, "Score")),
      winner: gagnant(a?.cell) ? "A" : gagnant(b?.cell) ? "B" : null,
      gamesA,
      gamesB,
      pointsA,
      pointsB,
    });
  }

  // Les colonnes de joueurs ne s'identifient pas : le rendu a changé, et TOUT ce qu'on croirait
  // lire serait faux (les noms, donc les rapprochements, donc le verdict). Une feuille vide, elle,
  // est légitime — mais elle ne l'est que si les colonnes, elles, étaient là.
  if (lines.length > 0 && codeA === null && codeB === null) {
    throw new TieUnreadableError(snTieId, "colonnes « A: » / « B: » introuvables");
  }

  return {
    snTieId,
    codeA,
    codeB,
    division: txt(valeur(ci, "Division")),
    group: txt(valeur(ci, "Groupe")),
    // « J1 » ici, « 1 » sur la fiche d'équipe : c'est CE format-là qui est celui d'`Interclub.round`.
    round: txt(valeur(ci, "Tour")),
    venue: txt(valeur(ci, "Lieu de la rencontre")),
    date: dateIso(quand.slice(0, 10)),
    time: heure(quand),
    lines,
    totals,
  };
}

/**
 * Télécharge la feuille de match d'une rencontre. UNE requête, UN identifiant.
 *
 * Aucune authentification : la feuille publiée est publique. L'espacement des appels appartient
 * à l'APPELANT, comme pour les rosters — squashnet est un site associatif qui ne nous doit rien.
 */
export async function fetchTieSheet(snTieId: string): Promise<TieSheet> {
  const html = await postAjax({
    ic_a: TIE_ACTION,
    mustache: "1",
    ic_ajax: "1",
    tieid: snTieId,
  });
  return parseTieSheet(html, snTieId);
}
