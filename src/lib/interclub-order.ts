// Ordre des simples d'une rencontre interclub, imposé par le classement des joueurs. Module
// PUR : aucun import de prisma ni de next/server, comme `interclub.ts` — testable sans base et
// utilisable côté client, pour prévenir plutôt que de laisser le serveur seul refuser.
//
// LA RÈGLE DU CLUB (compétition FFSquash) : le mieux classé des joueurs PRÉSENTS joue le simple
// n° 1, et les simples suivants s'enchaînent dans l'ordre décroissant de classement. Concrètement
// : si Albert (classé 5A) joue le simple 1, alors Benoît (classé 4D, MIEUX classé que 5A malgré
// la lettre) ne peut jouer AUCUN simple de cette rencontre — l'aligner casserait l'ordre quel
// que soit le numéro qu'on lui donnerait. Deux joueurs de MÊME classement (deux « 5A », ou deux
// « NC ») sont interchangeables : rien ne les départage, `RangM` n'intervient jamais ici.
//
// LE FORMAT « clt » (« 5A », « NC », « R1 », « N »…) est celui de squashnet.fr, déjà utilisé par
// `SquashnetRanking.clt` et par le tri de l'annuaire (`directorySort.ts`). Ce module ne le
// CONFOND JAMAIS avec un rang (`rang`/`rangM`, un entier) : le rang mesure une position dans un
// classement national qui bouge chaque mois et n'a pas vocation à ordonner une rencontre — deux
// joueurs du même classement peuvent avoir des rangs très différents sans que l'un doive jouer
// avant l'autre. C'est explicitement ce que demande la règle du club (« le classement RangM
// n'intervient pas »).

/**
 * Un « poids » de classement, PLUS PETIT = PLUS FORT — le sens naturel pour trier « le mieux
 * classé en tête ». Ce n'est PAS le classement lui-même : deux classements différents peuvent
 * partager un poids seulement s'ils sont réellement équivalents pour l'ordre (jamais le cas ici,
 * chaque classement reconnu a un poids distinct), et la valeur n'a aucun sens hors comparaison —
 * seul l'ORDRE relatif compte, jamais l'écart entre deux poids.
 */
export type ClassementPower = number;

/**
 * Poids d'un classement fédéral, ou `null` s'il n'est pas reconnu.
 *
 * Formats acceptés, du plus fort au plus faible :
 *   - « N »            (National)
 *   - « R1 », « R2 »    (Régional)
 *   - un chiffre (1 à 2 chiffres) suivi d'une lettre A à D — ex. « 4D », « 5A », « 10B » — où le
 *     CHIFFRE domine TOUJOURS la lettre : « 4D » est plus fort que « 5A », quand bien même D est
 *     la plus faible lettre de sa catégorie et A la plus forte de la sienne. À chiffre égal, A
 *     est la plus forte lettre et D la plus faible (« 5A » plus fort que « 5D »).
 *   - « NC »            (non classé) — le plus faible de tous, mais tous les NC sont ÉQUIVALENTS
 *     entre eux (interchangeables), exactement comme deux classements numérotés identiques.
 *
 * `null` couvre aussi bien « pas de classement connu » (le cas ne devrait pas se présenter ici :
 * l'appelant filtre les entrées sans classement avant d'appeler cette fonction) que « chaîne
 * mal formée » — une faute de saisie sur un classement forcé, par exemple. Dans les deux cas,
 * l'appelant ne peut pas ordonner ce joueur et doit le dire plutôt que deviner.
 */
export function classementPower(clt: string): ClassementPower | null {
  const v = clt.trim().toUpperCase();
  if (v === "N") return 0;
  if (v === "R1") return 1;
  if (v === "R2") return 2;
  if (v === "NC") return Number.POSITIVE_INFINITY;
  const m = /^(\d{1,2})([A-D])$/.exec(v);
  if (!m) return null;
  const numero = Number(m[1]);
  if (numero < 1) return null;
  const lettre = m[2].charCodeAt(0) - "A".charCodeAt(0); // A=0 (plus fort) … D=3 (plus faible)
  // ×10 pour que le chiffre domine TOUJOURS la lettre (0..3) : « R2 »=2 doit rester plus fort
  // que « 1A », donc la catégorie 1 démarre après R2, jamais avant.
  return 2 + numero * 10 + lettre;
}

/**
 * Normalise une saisie ADMIN de classement (invité sans compte, ou correction d'un membre) —
 * champ libre, donc source la plus probable d'une faute de frappe. Valide le format au moment
 * de la SAISIE plutôt que de laisser l'erreur ressurgir, opaque, le soir d'une rencontre au
 * moment de composer : `lineupOrderConflict` refuserait alors un classement mal formé sans
 * dire qu'il vient d'une faute de saisie ancienne.
 *
 * Chaîne vide (ou seulement des espaces) = pas de classement saisi, `null` accepté : ce n'est
 * pas une erreur, juste un champ qu'on n'a pas encore rempli.
 */
export function parseClassementInput(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "Classement invalide" };
  const trimmed = v.trim();
  if (!trimmed) return { ok: true, value: null };
  const upper = trimmed.toUpperCase();
  if (classementPower(upper) === null) {
    return { ok: false, error: "Classement invalide (ex. « 5A », « 4D », « NC »)" };
  }
  return { ok: true, value: upper };
}

/** Un simple désigné, tel qu'exposé par `interclub-roster.ts` — pas les simples « à désigner ». */
export interface OrderedSlot {
  /** Numéro du simple (1..matchCount), l'ordre de passage réel. */
  order: number;
  /** Nom d'affichage du joueur — sert uniquement à nommer le conflit dans le message. */
  name: string;
  /** Classement effectif du joueur, ou `null` si inconnu (jamais rapproché, jamais forcé). */
  clt: string | null;
}

/**
 * Le premier problème d'ordre dans une composition, ou `null` si tout va bien.
 *
 * N'EXAMINE QUE LES SIMPLES DÉSIGNÉS : l'appelant filtre en amont les « à désigner », dont
 * l'ordre n'a par construction rien à respecter — on inscrit souvent une rencontre avant de
 * savoir qui joue (cf. `interclub.ts`), et ce n'est pas une faute.
 *
 * MOINS DE DEUX SIMPLES DÉSIGNÉS ⇒ RIEN À VÉRIFIER. Un seul joueur désigné ne peut violer
 * aucun ordre — il n'y a personne d'autre à comparer — donc on ne réclame pas non plus son
 * classement à ce stade : composer le tout premier simple d'une rencontre, avant que quiconque
 * d'autre ne soit désigné, ne doit pas exiger un classement qui ne servira peut-être jamais.
 * L'exigence n'apparaît qu'au SECOND joueur désigné, quand une comparaison devient possible.
 *
 * Deux causes de refus dès qu'au moins deux simples sont désignés, dans cet ordre — la
 * première rencontrée est rendue :
 *   1. CLASSEMENT INCONNU. Un simple désigné mais dont le classement n'a pas pu être établi
 *      (joueur jamais rapproché sur squashnet, invité sans classement saisi, correction
 *      admin mal formée) rend la comparaison invérifiable : on ne peut pas prouver que l'ordre
 *      est respecté sans savoir où ce joueur se situe. On refuse plutôt que de supposer un
 *      ordre qui pourrait être faux — le club risquerait une sanction fédérale sur une
 *      hypothèse de l'appli.
 *   2. ORDRE VIOLÉ. Un simple de numéro plus GRAND porte un joueur mieux classé qu'un simple de
 *      numéro plus PETIT. Il suffit de comparer les simples désignés CONSÉCUTIFS une fois triés
 *      par numéro : par transitivité, une suite non-décroissante de poids sur des paires
 *      consécutives l'est sur TOUTES les paires — pas besoin de comparer chaque simple à tous
 *      les autres.
 */
export function lineupOrderConflict(slots: readonly OrderedSlot[]): string | null {
  if (slots.length < 2) return null;

  const sorted = [...slots].sort((a, b) => a.order - b.order);

  for (const s of sorted) {
    // `== null` et non `=== null` : englobe aussi un `clt` absent d'un objet mal construit,
    // sans que cette fonction pure ait à faire confiance à la forme exacte de son appelant.
    if (s.clt == null || classementPower(s.clt) === null) {
      return `${s.name} : classement inconnu — attribue-lui un classement avant de composer le simple n° ${s.order}`;
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    // Non-nul, vérifié par la boucle ci-dessus.
    const prevPower = classementPower(prev.clt as string) as ClassementPower;
    const curPower = classementPower(cur.clt as string) as ClassementPower;
    if (curPower < prevPower) {
      return (
        `${cur.name} (${cur.clt}) est mieux classé que ${prev.name} (${prev.clt}) : ` +
        `il doit jouer un simple numéroté avant le sien (actuellement simple n° ${prev.order}).`
      );
    }
  }

  return null;
}

/** Une entrée du roster telle que `RosterEntry` (`interclub-roster.ts`) l'expose au sélecteur. */
export interface RankableRosterEntry {
  name: string;
  clt: string | null;
  /** Rang national mixte (`SquashnetRanking.rangM`), ou `null` — toujours `null` pour un invité. */
  rangM: number | null;
}

/**
 * Ordre d'AFFICHAGE du sélecteur de composition : le mieux classé en tête. À NE PAS CONFONDRE
 * avec `lineupOrderConflict`, qui VALIDE l'ordre des simples DÉJÀ DÉSIGNÉS d'une rencontre —
 * celui-ci ne fait que trier une LISTE de choix possibles, et ne refuse jamais rien.
 *
 * Trois paliers, dans cet ordre :
 *   1. CLASSEMENT (`classementPower`), le plus fort en tête — un classement mal formé ou absent
 *      compte comme « inconnu » et passe systématiquement après tout classement reconnu, y
 *      compris `NC` (qui EST un classement, juste le plus faible) ;
 *   2. à classement égal (deux « 5A », deux `NC`, ou deux inconnus), le RANG MIXTE squashnet
 *      (`rangM`) le plus PETIT — mais seulement quand les DEUX camarades de palier le connaissent,
 *      sans quoi comparer un rang à une absence de rang n'aurait aucun sens (cf. `directorySort.ts`,
 *      même principe : on ne mélange jamais un rang connu et une absence de rang) ;
 *   3. sinon, ordre ALPHABÉTIQUE (déjà l'ordre reçu du serveur, `localeCompare` FR) — un tri
 *      stable laisse ce palier intact sans qu'on ait à le refaire ici.
 */
export function compareRosterOrder(a: RankableRosterEntry, b: RankableRosterEntry): number {
  const pa = a.clt != null ? classementPower(a.clt) : null;
  const pb = b.clt != null ? classementPower(b.clt) : null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  }
  if (a.rangM != null && b.rangM != null && a.rangM !== b.rangM) {
    return a.rangM - b.rangM;
  }
  return 0;
}
