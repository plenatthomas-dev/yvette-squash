import type { RankingRow } from "./client";

// ============================================================================
//  RAPPROCHEMENT membre ↔ ligne de classement squashnet (PUR, testé).
//  ResaMania n'expose pas de licence → on matche par NOM + CLUB. Règle d'or :
//  on n'affirme un classement que si UNE SEULE ligne du club colle au membre ;
//  sinon (0 ou plusieurs) on ne renvoie rien — jamais un mauvais classement.
//
//  DEUX ÉCHAPPATOIRES à cette règle, toutes deux réservées à l'HISTORIQUE :
//
//   * la LICENCE, quand on la connaît (elle vient du rapprochement déjà réussi au
//     club) : identifiant fédéral, insensible au club comme à l'orthographe ;
//   * le mode HORS CLUB, qui accepte l'unique ligne au nom du joueur quel que soit
//     son club — parce que la progression d'un joueur précède son arrivée ici.
//
//  Le rafraîchissement MENSUEL n'utilise ni l'un ni l'autre : il a besoin de savoir
//  qui a quitté le club, ce que seul le filtre par club permet de constater.
// ============================================================================

// Libellé du club tel que squashnet l'affiche (apostrophe déjà retirée par leur rendu).
export const YVETTE_CLUB = "Squash de l yvette";

export interface MemberIdentity {
  givenName: string;
  familyName: string;
  gender?: string | null; // "male" | "female" (issu de ResaMania), optionnel
}

export interface RankingMatch {
  clt: string;
  rang: number | null; // rang national DANS SON GENRE (plus petit = plus fort), têtes de série
  rangM: number | null; // rang national MIXTE (« M » = mixte) — le nombre affiché dans l'annuaire
  licence: string;
  cat: string;
  club: string;
  name: string; // nom tel qu'affiché par squashnet
  /**
   * MOYENNE DE POINTS (« 3 832.17 » → 3832.17), ou null si la case est vide ou illisible.
   *
   * Elle n'est affichée nulle part et ne sert à aucun tri : elle n'existe que pour
   * l'HISTORIQUE (`SquashnetRankingPoint.mean`), où elle est la seule des quatre valeurs qui
   * bouge tous les mois — donc la seule qui dessine une courbe.
   */
  mean: number | null;
}

/** Minuscule, sans accents, ponctuation/tirets/apostrophes → espaces, espaces compactés. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritiques combinants
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // tout le reste → espace
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(s: string): Set<string> {
  const n = normalize(s);
  return new Set(n ? n.split(" ") : []);
}

// Genres compatibles : incompatibles seulement si les DEUX sont connus et diffèrent.
function genderOk(a: string | null | undefined, b: string): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  if (!x || !y || (x !== "male" && x !== "female") || (y !== "male" && y !== "female")) {
    return true;
  }
  return x === y;
}

// Le nom du membre (prénom + nom) doit être INCLUS dans les jetons de la ligne (ordre
// indifférent : squashnet affiche « NOM PRÉNOM »). Tolère un 2e prénom côté squashnet.
function nameMatches(member: MemberIdentity, rowName: string): boolean {
  const want = tokenSet(`${member.givenName} ${member.familyName}`);
  if (want.size === 0) return false;
  const have = tokenSet(rowName);
  for (const t of want) if (!have.has(t)) return false;
  return true;
}

// Les rangs arrivent en texte, parfois avec une espace de milliers (« 2 339 »). Lecture
// STRICTE, à deux titres : on n'accepte que des chiffres (« 3184e » ou « NC » → null, là où
// parseInt aurait retenu 3184), et on refuse zéro. Un rang commence à 1 : un « 0 » est une
// case vide déguisée, et le laisser passer le placerait en TÊTE du tri « Classement » de
// l'annuaire — devant les mieux classés du club.
function toRank(raw: string): number | null {
  if (!/^\d+$/.test(raw.replace(/\s/g, ""))) return null;
  const n = parseInt(raw.replace(/\s/g, ""), 10);
  return n > 0 ? n : null;
}

/**
 * « 3 832.17 » → 3832.17. Les milliers sont séparés par une ESPACE (parfois insécable), la
 * décimale par un point — c'est le format que rend squashnet, vérifié sur fixture.
 *
 * Lecture STRICTE comme `toRank`, et pour la même raison : `parseFloat("3 832.17")` rend 3,
 * une valeur cent fois trop petite qui a l'air d'un nombre. Zéro est refusé — une moyenne nulle
 * n'existe pas dans ce classement, c'est une case vide déguisée, et elle écraserait la courbe.
 * La virgule décimale est acceptée au cas où la fédération francise son rendu un jour ; le
 * point reste ce qu'on observe.
 */
function toMean(raw: string): number | null {
  const nettoye = (raw ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(nettoye)) return null;
  const n = Number.parseFloat(nettoye);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toMatch(c: RankingRow): RankingMatch {
  return {
    clt: c.clt,
    rang: toRank(c.rang),
    rangM: toRank(c.rangM),
    licence: c.licence,
    cat: c.cat,
    club: c.club,
    name: c.name,
    mean: toMean(c.mean),
  };
}

/**
 * Renvoie la ligne de classement correspondant au membre dans le club cible, ou null si
 * l'appariement est ambigu ou absent. `opts.club` permet de viser un autre club (défaut :
 * Squash de l'Yvette).
 */
export function matchRanking(
  member: MemberIdentity,
  rows: RankingRow[],
  opts: { club?: string } = {},
): RankingMatch | null {
  const target = normalize(opts.club ?? YVETTE_CLUB);
  const candidates = rows.filter(
    (r) =>
      normalize(r.club) === target &&
      genderOk(member.gender, r.gender) &&
      nameMatches(member, r.name),
  );
  if (candidates.length !== 1) return null; // 0 ou homonymes → on n'affirme rien
  return toMatch(candidates[0]);
}

/**
 * Verdict d'appariement pour décider quoi FAIRE du classement d'un membre :
 *  - `matched` : une seule ligne du club cible colle → on met à jour ce classement ;
 *  - `moved`   : le nom du membre est retrouvé, mais UNIQUEMENT dans d'autres clubs → il a
 *                quitté le club → signal POSITIF d'absence, on peut retirer son classement ;
 *  - `unknown` : tout le reste (aucune ligne au nom du membre — possible troncature/pagination
 *                ou hoquet squashnet —, ou plusieurs lignes ambiguës dans le club cible) → on
 *                ne touche à RIEN (ni écriture ni suppression). C'est le défaut sûr.
 *
 * Contrairement à `matchRanking`, ce classifieur ne confond jamais « pas trouvé » avec
 * « absent » : une simple absence de hit (fréquente à cause de la pagination sur les noms
 * courants) ne déclenche plus de suppression.
 */
export type RankingVerdict =
  | { status: "matched"; match: RankingMatch }
  | { status: "moved" }
  | { status: "unknown" };

export function classifyRanking(
  member: MemberIdentity,
  rows: RankingRow[],
  opts: { club?: string; horsClub?: boolean; licence?: string | null } = {},
): RankingVerdict {
  // ── 1. LA LICENCE D'ABORD, quand on la connaît. ────────────────────────────────────────────
  //
  // C'est un identifiant fédéral : il ne dépend ni du club, ni de l'orthographe du nom, ni des
  // homonymes. Quand le membre a déjà été rapproché une fois (donc aujourd'hui, au club), on
  // tient son numéro, et les mois PASSÉS se retrouvent alors sans la moindre ambiguïté — y
  // compris ceux où il était licencié ailleurs.
  //
  // Une licence connue mais absente de la réponse ne conclut RIEN : on retombe sur le nom. Elle
  // peut manquer parce que le joueur n'était pas licencié ce mois-là, mais aussi parce que la
  // colonne est vide sur cette ligne-là — deux situations qu'on ne sait pas départager ici.
  const licence = (opts.licence ?? "").trim();
  if (licence) {
    const parLicence = rows.filter((r) => r.licence.trim() === licence);
    if (parLicence.length === 1) return { status: "matched", match: toMatch(parLicence[0]) };
  }

  const target = normalize(opts.club ?? YVETTE_CLUB);
  // Lignes qui portent le nom (et le genre) du membre, tous clubs confondus.
  const byName = rows.filter((r) => genderOk(member.gender, r.gender) && nameMatches(member, r.name));

  // ── 2. HORS CLUB : l'historique suit le JOUEUR, pas le membre du club. ─────────────────────
  //
  // Demandé pour le remplissage rétroactif uniquement. Un membre arrivé l'an dernier a une
  // progression avant son arrivée, et la refuser sous prétexte que le libellé du club diffère
  // reviendrait à confondre « il est parti » avec « il n'était pas encore là ».
  //
  // ⚠️ CE MODE NE REND JAMAIS `moved`, ET C'EST TOUT SON INTÉRÊT : il n'y a plus de « dehors »
  // dont on pourrait constater l'absence. Il ne doit donc PAS servir au rafraîchissement
  // mensuel, qui a besoin de ce verdict pour retirer le classement de quelqu'un qui a quitté le
  // club (et dont le disjoncteur de volume dépend).
  //
  // Plusieurs lignes au même nom restent `unknown` : deux personnes portant ce nom un même mois
  // sont deux personnes, et rien ici ne dit laquelle. C'est le seul cas que la licence, quand
  // on l'a, tranche pour de bon.
  if (opts.horsClub) {
    if (byName.length === 1) return { status: "matched", match: toMatch(byName[0]) };
    return { status: "unknown" };
  }

  // ── 3. LE DÉFAUT : dans le club, et le club seul. ──────────────────────────────────────────
  const inClub = byName.filter((r) => normalize(r.club) === target);
  if (inClub.length === 1) return { status: "matched", match: toMatch(inClub[0]) };
  // Nom retrouvé, mais aucune occurrence dans le club cible → parti ailleurs (signal fiable).
  if (inClub.length === 0 && byName.length > 0) return { status: "moved" };
  // 0 hit au nom (peut-être en page 2 / squashnet muet) OU homonymes ambigus dans le club.
  return { status: "unknown" };
}

/** Terme de recherche squashnet pour un membre : le nom de famille (le plus discriminant). */
export function searchQuery(member: MemberIdentity): string {
  return member.familyName.trim();
}
