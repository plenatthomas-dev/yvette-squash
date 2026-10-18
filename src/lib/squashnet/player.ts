import { postAjax } from "./client";
import { TR, attr, cellule, cellules, dateIso, heure, rang, texte, txt, valeur } from "./html";
import { normalize } from "./match";
import { joueur, type TiePlayer } from "./tie";

// ============================================================================
//  LA FICHE D'UN JOUEUR (squashnet.fr), PUBLIQUE : `ic_a=393477&regiid=<id>`.
//
//  C'est la page qu'ouvre un clic sur un nom, partout sur le site — dans le
//  classement de poule comme sur la fiche d'équipe. Elle publie l'identité du
//  joueur, puis TOUS ses matchs de l'épreuve, toutes équipes confondues :
//  rencontre, date, son classement ce soir-là, l'adversaire et le sien, le
//  résultat et le score, écrit DE SON POINT DE VUE (il est en premier).
//
//  Mesuré le 2026-10-18 sur KADI RAFIK (644801) : 5,6 Ko, deux matchs, les mêmes
//  que Squash App. Le seul paramètre est `regiid` — l'identifiant d'une
//  INSCRIPTION dans une épreuve, pas d'une personne (cf. `TiePlayer.regiid`).
//
//  Une section sœur, `ic_a=393474`, rend les mêmes matchs (lien de la feuille de
//  match). On lit celle-ci : son tableau porte un identifiant stable
//  (`table_results`), la date complète en `data-order`, et les trois valeurs de
//  classement de l'adversaire là où l'autre n'en garde que deux.
//
//  ⚠️ L'INTITULÉ DE LA RENCONTRE N'EST PAS ORDONNÉ. « Verrieres 4-Squash in
//  Issy » désigne une rencontre jouée À ISSY : la fiche ne dit pas qui reçoit.
//  Et le séparateur est un tiret sans espaces, que rien n'interdit dans un nom
//  d'équipe. On le garde donc tel quel ; c'est l'appelant, qui connaît les noms
//  des équipes de la poule, qui sait le découper (`splitTieLabel`).
// ============================================================================

/** Action AJAX de la section « Fiche d'un joueur ». */
const PLAYER_ACTION = "393477";

/** Le fragment n'est pas la fiche lisible de ce joueur — même doctrine que `TieUnreadableError`. */
export class PlayerUnreadableError extends Error {
  constructor(regiid: string, raison: string) {
    super("fiche joueur illisible pour " + regiid + " : " + raison);
    this.name = "PlayerUnreadableError";
  }
}

/** Un match de la fiche, tel que la ligue le publie, DU POINT DE VUE DU JOUEUR. */
export interface PlayerMatch {
  /** « Verrieres 5-Squash in Issy », tel quel (cf. l'en-tête : non ordonné). */
  tie: string;
  /** « YYYY-MM-DD ». */
  date: string | null;
  time: string | null;
  /** Son classement ce soir-là. */
  clt: string | null;
  rang: number | null;
  rangM: number | null;
  opponent: TiePlayer | null;
  /** Null sur un libellé inconnu : on ne range pas un « Abandon » dans la case voisine. */
  result: "won" | "lost" | null;
  /** « 11-5 11-8 13-15 11-7 », SON score en premier. */
  score: string | null;
}

/** Une fiche joueur, réduite à ce qu'on en retient. */
export interface PlayerHistory {
  regiid: string;
  /** « KADI RAFIK ». */
  name: string | null;
  licence: string | null;
  /** Catégorie d'âge, « +45 ». */
  category: string | null;
  clt: string | null;
  rang: number | null;
  rangM: number | null;
  matches: PlayerMatch[];
}

const RESULTATS: ReadonlyMap<string, "won" | "lost"> = new Map([
  ["gagne", "won"],
  ["perdu", "lost"],
]);

/** « 5B - 4086 - 4976 » → ses trois valeurs. */
function troisValeurs(raw: string): { clt: string | null; rang: number | null; rangM: number | null } {
  const [c, r, m] = raw.split("-").map((p) => p.trim());
  return { clt: txt(c), rang: rang(r), rangM: rang(m) };
}

/** « Niveau : 5B - Rang : 4086 - RangM : 4976 » → ses trois valeurs. */
function classementInfo(raw: string): { clt: string | null; rang: number | null; rangM: number | null } {
  return {
    clt: txt(/Niveau\s*:\s*([^\s-]+)/i.exec(raw)?.[1]),
    rang: rang(/Rang\s*:\s*(\d+)/.exec(raw)?.[1]),
    rangM: rang(/RangM\s*:\s*(\d+)/.exec(raw)?.[1]),
  };
}

/**
 * La fiche, lue dans le fragment rendu par la fédération.
 *
 * Vérifie que c'est bien le joueur demandé quand le fragment le dit (`setUrl(...regiid=…)` en
 * pied, comme la feuille de match) : servir les matchs d'un autre sous ce nom est la panne
 * muette que tout le dépôt évite. Jette si le tableau des résultats manque ; rend une liste
 * vide s'il est là sans ligne — un joueur inscrit qui n'a pas encore joué est un fait.
 */
export function parsePlayer(html: string, regiid: string): PlayerHistory {
  const ids = [...html.matchAll(/participants\?[^"'\s]*regiid=(\d+)/gi)].map((m) => m[1]);
  if (ids.length > 0 && !ids.includes(regiid)) {
    throw new PlayerUnreadableError(regiid, "le fragment porte le joueur " + ids[0]);
  }

  const resultats = /<table[^>]*id=["']table_results["'][^>]*>[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!resultats) throw new PlayerUnreadableError(regiid, "tableau des résultats absent");

  const info = /<table[^>]*id=["']info["'][^>]*>[\s\S]*?<\/table>/i.exec(html)?.[0] ?? "";
  const ci = cellules(info);

  const matches: PlayerMatch[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(resultats)) !== null) {
    const c = cellules(tr[1]);
    if (c.length === 0) continue; // l'en-tête, en <th>

    const tie = valeur(c, "Rencontre");
    if (!tie) continue;
    const cellDate = cellule(c, "Date");
    // `data-order` porte « 2026-10-08 20:00:00 » : la date ET l'heure, que la case visible n'a pas.
    const ordre = cellDate ? attr(cellDate.attrs, "data-order") : null;
    matches.push({
      tie,
      date: /^\d{4}-\d{2}-\d{2}/.test(ordre ?? "")
        ? (ordre as string).slice(0, 10)
        : dateIso(valeur(c, "Date")),
      time: heure(ordre),
      ...troisValeurs(valeur(c, "Clt")),
      opponent: joueur(cellule(c, "Adversaire")),
      result: RESULTATS.get(normalize(valeur(c, "Résultat"))) ?? null,
      score: txt(valeur(c, "Score")),
    });
  }

  return {
    regiid,
    name: txt(valeur(ci, "Identité")),
    licence: txt(valeur(ci, "Licence")),
    category: txt(valeur(ci, "Catégorie")),
    ...classementInfo(valeur(ci, "Classement")),
    matches,
  };
}

/**
 * « Verrieres 5-Squash in Issy » → les deux équipes, si on sait où couper.
 *
 * On ne coupe QUE sur un nom connu (ceux de la poule) : un tiret peut appartenir à un nom
 * d'équipe, et une coupe devinée attribuerait un match à un club qui n'y était pas. Sans nom
 * connu des deux côtés, null — l'écran affiche l'intitulé tel quel.
 */
export function splitTieLabel(label: string, knownNames: readonly string[]): [string, string] | null {
  const plie = (s: string) => texte(s).toLowerCase();
  const l = plie(label);
  for (const a of knownNames) {
    const pa = plie(a);
    if (!pa || !l.startsWith(pa)) continue;
    const reste = l.slice(pa.length).replace(/^\s*-\s*/, "");
    if (reste === l.slice(pa.length)) continue; // pas de tiret juste après : « Verrieres 2 » ≠ « Verrieres 21 »
    const b = knownNames.find((n) => plie(n) === reste);
    if (b) return [a, b];
  }
  return null;
}

/** Télécharge la fiche d'un joueur. UNE requête ; l'espacement appartient à l'appelant. */
export async function fetchPlayer(regiid: string): Promise<PlayerHistory> {
  const html = await postAjax({ ic_a: PLAYER_ACTION, mustache: "1", ic_ajax: "1", regiid });
  return parsePlayer(html, regiid);
}

/** Cette valeur a-t-elle la forme d'une fiche joueur ? (Relue d'une colonne texte.) */
export function estFicheJoueur(v: unknown): v is PlayerHistory {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.regiid === "string" &&
    Array.isArray(p.matches) &&
    p.matches.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as Record<string, unknown>).tie === "string",
    )
  );
}
