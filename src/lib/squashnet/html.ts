// ============================================================================
//  LES PRIMITIVES DE LECTURE DU HTML FÉDÉRAL, en un seul endroit.
//
//  Trois parseurs partagent exactement ces quatre fonctions : la fiche d'équipe
//  (`roster.ts`), la feuille de match (`tie.ts`) et le classement de poule. Les
//  recopier, c'est se condamner à ne corriger qu'une copie sur trois le jour où
//  squashnet change quelque chose — et il l'a déjà fait, en basculant tout son
//  HTML des guillemets doubles aux simples sans prévenir (2026-08-26).
//
//  ⚠️ TOUT S'ANCRE SUR `data-label`, JAMAIS SUR LA POSITION D'UNE COLONNE. C'est
//  la doctrine du dépôt, et elle vient d'une panne réelle : une colonne insérée
//  décalait un parsing positionnel SANS RIEN CASSER DE VISIBLE — on lisait le
//  rang à la place du rang mixte, et l'ordre des simples se contrôlait sur un
//  chiffre faux mais crédible.
//
//  Ce n'est pas un parseur HTML, et ça n'a pas à l'être : on lit des fragments
//  rendus par un serveur, dont on a des captures réelles en fixtures, et dont
//  chaque évolution doit nous ARRÊTER plutôt que d'être absorbée en silence.
// ============================================================================

/** Une cellule ENTIÈRE : ses attributs d'un côté, son contenu de l'autre. */
const TD_BRUT = /<td([^>]*)>([\s\S]*?)<\/td>/gi;

/** Les lignes d'un tableau. `[\s\S]*?` s'arrête au premier `</tr>` — pas de ligne imbriquée. */
export const TR = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

/** Retire les balises, déplie les entités courantes, et normalise les espaces. */
export function texte(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * La valeur d'un attribut dans un fragment.
 *
 * Le nom est ancré sur une frontière À GAUCHE (début, ou espace) : sans elle, chercher `id`
 * ramènerait la valeur de `data-tieid`, et chercher `teamid` celle de `data-teamid`. Les deux
 * attributs coexistent dans la même cellule sur la fiche d'équipe.
 *
 * Tolère les guillemets simples ET doubles, pour la raison dite en tête de fichier.
 *
 * Null = ABSENT ; chaîne vide = présent et vide. La nuance porte : c'est `data-label` qui
 * distingue une cellule d'un en-tête, et une cellule d'intitulé VIDE (la ligne « Total » d'une
 * feuille de match) reste une cellule.
 */
export function attr(fragment: string, nom: string): string | null {
  const m = new RegExp("(?:^|\\s)" + nom + "=[\"']([^\"']*)[\"']", "i").exec(fragment);
  return m ? m[1].trim() : null;
}

/** Une cellule, telle qu'on la manipule : son intitulé, ses attributs, son contenu brut. */
export interface Cellule {
  label: string;
  attrs: string;
  html: string;
}

/**
 * Les cellules d'une ligne, DANS L'ORDRE DE LA PAGE.
 *
 * ⚠️ UNE LISTE, PAS UNE CARTE, et c'est délibéré. Une feuille de match étiquette ses deux
 * colonnes de joueurs avec le SIGLE de chaque équipe (« A:VERR2 », « B:VERR3 ») : ces intitulés
 * sont des données, pas un vocabulaire fixe, et rien n'interdit à deux équipes de porter le même
 * sigle. Une carte en perdrait silencieusement une — donc une moitié de la feuille.
 *
 * Les lignes d'en-tête (en `<th>`, sans `data-label`) rendent une liste VIDE : c'est ainsi que
 * les appelants les écartent.
 */
export function cellules(trHtml: string): Cellule[] {
  const out: Cellule[] = [];
  TD_BRUT.lastIndex = 0;
  let td: RegExpExecArray | null;
  while ((td = TD_BRUT.exec(trHtml)) !== null) {
    const label = attr(td[1], "data-label");
    if (label !== null) out.push({ label, attrs: td[1], html: td[2] });
  }
  return out;
}

/** La première cellule portant cet intitulé, ou undefined. */
export function cellule(cs: readonly Cellule[], label: string): Cellule | undefined {
  return cs.find((c) => c.label === label);
}

/** Le texte de la première cellule portant cet intitulé (chaîne vide si absente). */
export function valeur(cs: readonly Cellule[], label: string): string {
  return texte(cellule(cs, label)?.html ?? "");
}

/** Une valeur, ou null si elle est vide (jamais la chaîne vide, qui se teste mal). */
export function txt(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  return v || null;
}

/**
 * Un entier positif, ou null.
 *
 * Lecture STRICTE, reprise de `match.ts` : « NC » n'est pas 0, et un rang commence à 1 — un zéro
 * est une case vide déguisée, et le laisser passer placerait le joueur EN TÊTE de l'ordre des
 * simples, donc devant les mieux classés de son équipe.
 */
export function rang(raw: string | undefined | null): number | null {
  const v = (raw ?? "").replace(/\s/g, "");
  if (!/^\d+$/.test(v)) return null;
  const n = Number.parseInt(v, 10);
  return n > 0 ? n : null;
}

/**
 * Un entier, ZÉRO COMPRIS. Distinct de `rang` : un compte de jeux gagnés vaut légitimement 0,
 * là qu'un rang ne le vaut jamais. Les confondre effacerait les 0-3 d'une feuille de match.
 */
export function entier(raw: string | undefined | null): number | null {
  const v = (raw ?? "").replace(/\s/g, "");
  return /^\d+$/.test(v) ? Number.parseInt(v, 10) : null;
}

/**
 * « 22-09-2025 » → « 2025-09-22 ». Null si ce n'est pas une date.
 *
 * Le format ISO est celui de tout le dépôt (`Interclub.date`, `SquashnetRankingPoint.month`) :
 * il se trie comme du texte. Garder le format fédéral ferait trier septembre après octobre.
 */
export function dateIso(raw: string | undefined | null): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((raw ?? "").trim());
  return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}

/**
 * L'heure d'un horodatage fédéral, « HH:MM ».
 *
 * ⚠️ LES DEUX SÉPARATEURS EXISTENT, mesurés sur la même épreuve : `data-order` écrit
 * « 2025-10-09 20:00:00 » (deux-points), la fiche de rencontre « 09-10-2025 20-00 » (tiret).
 * N'en accepter qu'un rendrait l'heure NULLE une fois sur deux, sans rien signaler.
 */
export function heure(raw: string | undefined | null): string | null {
  const m = /(\d{2})[:-](\d{2})(?:[:-]\d{2})?\s*$/.exec((raw ?? "").trim());
  return m ? m[1] + ":" + m[2] : null;
}
