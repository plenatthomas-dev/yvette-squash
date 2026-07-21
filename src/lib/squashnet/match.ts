import type { RankingRow } from "./client";

// ============================================================================
//  RAPPROCHEMENT membre ↔ ligne de classement squashnet (PUR, testé).
//  ResaMania n'expose pas de licence → on matche par NOM + CLUB. Règle d'or :
//  on n'affirme un classement que si UNE SEULE ligne du club colle au membre ;
//  sinon (0 ou plusieurs) on ne renvoie rien — jamais un mauvais classement.
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
  rang: number | null; // rang national (plus petit = plus fort), pour trier les têtes de série
  licence: string;
  cat: string;
  club: string;
  name: string; // nom tel qu'affiché par squashnet
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

function toMatch(c: RankingRow): RankingMatch {
  const rangNum = parseInt(c.rang.replace(/\s/g, ""), 10);
  return {
    clt: c.clt,
    rang: Number.isFinite(rangNum) ? rangNum : null,
    licence: c.licence,
    cat: c.cat,
    club: c.club,
    name: c.name,
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
  opts: { club?: string } = {},
): RankingVerdict {
  const target = normalize(opts.club ?? YVETTE_CLUB);
  // Lignes qui portent le nom (et le genre) du membre, tous clubs confondus.
  const byName = rows.filter((r) => genderOk(member.gender, r.gender) && nameMatches(member, r.name));
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
