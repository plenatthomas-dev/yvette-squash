import { nameKey } from "./squashnet/roster";
import type { TieLine, TieSheet } from "./squashnet/tie";

// ============================================================================
//  « LA LIGUE PUBLIE 4-1. TON RELEVÉ DIT 4-1. »
//
//  Ce module confronte DEUX documents qui devraient dire la même chose : la
//  feuille de match que l'appli a tenue pendant la rencontre, et celle que la
//  ligue a publiée après saisie. Il ne corrige rien et ne saisit rien — il
//  CONSTATE, et nomme l'écart.
//
//  POURQUOI ÇA VAUT LE COUP. Une erreur de saisie fédérale ne se voit nulle
//  part : elle ne produit ni message ni alerte, elle produit un classement de
//  fin de saison. Aujourd'hui, la seule façon de la repérer est d'aller relire
//  la feuille publiée sur squashnet, match par match, ce que personne ne fait.
//  Et l'appli, elle, a le relevé exact — jeu par jeu, marqué en direct.
//
//  ⚠️ CE MODULE NE DÉCIDE JAMAIS À LA PLACE DU CAPITAINE. Un écart n'est pas une
//  faute prouvée : c'est peut-être NOTRE relevé qui est faux (un jeu mal marqué,
//  un simple saisi deux fois). On dit « ça ne concorde pas », jamais « ils se
//  sont trompés ». C'est la même retenue que `checkAwayOrder`, et pour la même
//  raison : envoyer un capitaine contester une feuille juste coûte bien plus
//  cher que de se taire.
//
//  PUR, SANS PRISMA ET SANS RÉSEAU, comme `interclub-order.ts` et
//  `captain-check.ts` : la règle appliquée est exactement celle que l'écran
//  affiche, et elle se teste sans base.
// ============================================================================

/**
 * De quel côté de la feuille fédérale sommes-nous ?
 *
 * ⚠️ LA QUESTION N'EST PAS RHÉTORIQUE, et s'y tromper inverse tout. La ligue nomme les deux
 * camps « A » et « B » sans dire lequel reçoit (cf. `tie.ts`). Se tromper de côté afficherait un
 * 4-1 gagné sur une rencontre perdue — une erreur pire que l'absence d'information, parce
 * qu'elle est crédible et qu'elle rassure.
 */
export type OurSide = "A" | "B";

/** Ce qui permet de reconnaître notre côté sur la feuille fédérale. */
export interface SideHints {
  /** Sigle de NOTRE équipe (« VERR2 »), si on le connaît. */
  ourCode?: string | null;
  /** Sigle de l'équipe adverse, si on le connaît. C'est le plus souvent celui-là qu'on a. */
  opponentCode?: string | null;
  /** Les noms que NOUS avons alignés. */
  ourNames?: readonly string[];
}

function memeCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Notre côté sur la feuille, ou null si rien ne permet de trancher.
 *
 * DEUX TÉMOINS, dans cet ordre :
 *
 *  1. LE SIGLE. C'est la donnée de la ligue elle-même, et elle est sans ambiguïté. On connaît
 *     presque toujours celui de l'ADVERSAIRE (son roster est en cache) même quand on ignore le
 *     nôtre — d'où les deux entrées.
 *  2. LES NOMS ALIGNÉS. Quand aucun sigle n'est connu, le côté qui porte nos joueurs est le
 *     nôtre. Ce témoin-là est à nous, pas à la ligue, donc il ne dépend d'aucun cache.
 *
 * ET NULL PLUTÔT QU'UN PARI. Un côté deviné au hasard a une chance sur deux d'inverser le score :
 * mieux vaut afficher « on n'a pas su rapprocher » que d'annoncer une victoire imaginaire.
 */
export function ourSide(sheet: TieSheet, hints: SideHints): OurSide | null {
  if (memeCode(sheet.codeA, hints.ourCode) || memeCode(sheet.codeB, hints.opponentCode)) return "A";
  if (memeCode(sheet.codeB, hints.ourCode) || memeCode(sheet.codeA, hints.opponentCode)) return "B";

  const nôtres = new Set((hints.ourNames ?? []).map(nameKey).filter(Boolean));
  if (nôtres.size === 0) return null;

  let a = 0;
  let b = 0;
  for (const l of sheet.lines) {
    if (l.a && nôtres.has(nameKey(l.a.name))) a += 1;
    if (l.b && nôtres.has(nameKey(l.b.name))) b += 1;
  }
  // L'ÉGALITÉ NE TRANCHE PAS — zéro-zéro compris. Deux équipes du même club peuvent aligner des
  // homonymes, et une feuille vide ne reconnaît personne : dans les deux cas, deviner serait
  // pire que se taire.
  return a === b ? null : a > b ? "A" : "B";
}

/**
 * Ce que la ligue publie, confronté à notre relevé.
 *
 * Les six états couvrent ce qui peut réellement arriver un lundi soir, et surtout : ils ne se
 * confondent pas. « Elle n'a rien saisi » et « on n'a pas su lire » appellent deux gestes
 * opposés — relancer l'adversaire, ou recapter une fixture.
 */
export type OfficialStatus =
  /** La rencontre n'a pas d'identifiant fédéral : il n'y a rien à aller lire. */
  | "absent"
  /** On n'a pas su lire la feuille : silence de squashnet, ou rendu qui a changé. */
  | "unread"
  /** Feuille atteinte, mais AUCUN simple saisi : la ligue attend encore la saisie. */
  | "empty"
  /** Une partie des simples est saisie, pas tous. */
  | "partial"
  /** Tout concorde — le score de la rencontre ET chaque simple. */
  | "match"
  /** Quelque chose ne concorde pas. Les écarts sont énumérés. */
  | "diverges";

export interface OfficialCheck {
  status: OfficialStatus;
  /**
   * Le score PUBLIÉ PAR LA LIGUE, remis dans NOTRE sens (nous d'abord).
   *
   * Null quand la feuille n'a pas été lue, ou quand on n'a pas su reconnaître notre côté — cas
   * où l'afficher reviendrait à jouer à pile ou face avec le résultat.
   */
  home: number | null;
  away: number | null;
  /** Le score de NOTRE relevé, repris tel quel pour que l'écran n'ait pas à le rechercher. */
  oursHome: number | null;
  oursAway: number | null;
  /**
   * Les écarts, en clair, un par phrase. Vide quand tout concorde.
   *
   * Formulés comme des CONSTATS (« la ligue publie X, notre relevé dit Y »), jamais comme des
   * accusations : l'un des deux documents est faux, et rien ici ne dit lequel.
   */
  problems: string[];
  /** Notre côté sur la feuille, quand on a su le reconnaître. */
  side: OurSide | null;
  /** L'adresse publique de la feuille, pour aller voir de ses yeux. */
  url: string | null;
}

/** L'adresse publique d'une feuille de match, celle qu'on ouvre dans un navigateur. */
export function tieUrl(snTieId: string): string {
  // `eventid` et `teamid` sont acceptés à -1 par squashnet : c'est la forme que le site
  // construit lui-même (relevée dans le `setUrl` de la feuille), et le `tieid` suffit.
  return (
    "https://www.squashnet.fr/competition/public/equipes/rencontre?eventid=-1&teamid=-1&tieid=" +
    snTieId
  );
}

/**
 * Le constat « rien à confronter », quand la rencontre ne porte pas d'identifiant fédéral.
 *
 * DISTINCT de « non lue », et la distinction porte : `absent` veut dire qu'il n'y a rien à
 * aller chercher (rencontre saisie à la main, ou calendrier jamais réimporté depuis que la
 * colonne existe), `unread` que la ligue n'a pas répondu. Le premier appelle un import, le
 * second une nouvelle tentative — les confondre enverrait réessayer indéfiniment une lecture
 * qui n'a jamais eu de cible.
 */
export function officialAbsent(ours: readonly OurLine[]): OfficialCheck {
  return {
    status: "absent",
    home: null,
    away: null,
    oursHome: ours.length > 0 ? ours.filter((l) => l.winner === "home").length : null,
    oursAway: ours.length > 0 ? ours.filter((l) => l.winner === "away").length : null,
    problems: [],
    side: null,
    url: null,
  };
}

/** Un simple de NOTRE relevé, réduit à ce que la confrontation regarde. */
export interface OurLine {
  order: number;
  homeDisplayName: string;
  awayName: string;
  /** Jeux gagnés de chaque côté, tels que `checkScore` les a comptés. */
  gamesHome: number;
  gamesAway: number;
  /** Le vainqueur selon notre relevé, ou null si le simple est inachevé. */
  winner: "home" | "away" | null;
}

/** Le numéro d'ordre porté par un intitulé fédéral (« Homme 1 » → 1), ou null. */
function ordreDe(label: string): number | null {
  const m = /(\d+)\s*$/.exec(label);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Le joueur de NOTRE côté sur une ligne fédérale, et celui d'en face. */
function cotes(l: TieLine, side: OurSide) {
  return side === "A"
    ? { nous: l.a, eux: l.b, jeuxNous: l.gamesA, jeuxEux: l.gamesB, gagne: l.winner === "A" }
    : { nous: l.b, eux: l.a, jeuxNous: l.gamesB, jeuxEux: l.gamesA, gagne: l.winner === "B" };
}

/** Deux noms désignent-ils le même joueur ? Ordre des mots indifférent (cf. `nameKey`). */
function memeJoueur(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = a ? nameKey(a) : "";
  const kb = b ? nameKey(b) : "";
  return ka !== "" && ka === kb;
}

/**
 * Confronte notre relevé à la feuille publiée.
 *
 * `ours` est notre relevé simple par simple, `sheet` la feuille fédérale, `side` notre côté sur
 * celle-ci (cf. `ourSide` — et `null` si on n'a pas su le reconnaître, auquel cas on ne compare
 * RIEN plutôt que de comparer à l'envers).
 *
 * ⚠️ LE SCORE DE LA RENCONTRE EST LU, PAS RECALCULÉ (`sheet.totals`). C'est la ligue qui compte
 * les points du championnat : si son total ne correspond pas à ses propres simples, c'est son
 * total qui fera le classement, et c'est donc lui qu'il faut montrer. Le recalculer masquerait
 * précisément l'erreur la plus coûteuse.
 */
export function compareOfficial(
  ours: readonly OurLine[],
  sheet: TieSheet | null,
  side: OurSide | null,
  matchCount: number,
): OfficialCheck {
  const oursHome = ours.filter((l) => l.winner === "home").length;
  const oursAway = ours.filter((l) => l.winner === "away").length;
  const base = {
    oursHome: ours.length > 0 ? oursHome : null,
    oursAway: ours.length > 0 ? oursAway : null,
  };

  if (!sheet) {
    return { status: "unread", home: null, away: null, ...base, problems: [], side: null, url: null };
  }

  const url = tieUrl(sheet.snTieId);
  const saisis = sheet.lines.filter((l) => l.a || l.b);

  if (saisis.length === 0) {
    return { status: "empty", home: null, away: null, ...base, problems: [], side, url };
  }

  // NOTRE CÔTÉ INCONNU = AUCUNE COMPARAISON. Tout ce qui suit dépend de savoir qui est qui :
  // comparer à l'envers produirait une liste d'écarts entièrement fausse, et un score inversé.
  if (side === null) {
    return {
      status: "unread",
      home: null,
      away: null,
      ...base,
      problems: [
        "Feuille fédérale lue, mais impossible de reconnaître notre équipe parmi les deux " +
          "colonnes : aucune comparaison n'est faite plutôt qu'une comparaison à l'envers.",
      ],
      side: null,
      url,
    };
  }

  const home = side === "A" ? (sheet.totals?.matchesA ?? null) : (sheet.totals?.matchesB ?? null);
  const away = side === "A" ? (sheet.totals?.matchesB ?? null) : (sheet.totals?.matchesA ?? null);

  const problems: string[] = [];

  if (home !== null && away !== null && base.oursHome !== null && base.oursAway !== null) {
    if (home !== base.oursHome || away !== base.oursAway) {
      problems.push(
        `La ligue publie ${home}-${away} ; notre relevé dit ${base.oursHome}-${base.oursAway}.`,
      );
    }
  }

  // Rapprochement PAR NUMÉRO DE SIMPLE (« Homme 3 » ↔ notre simple n° 3), jamais par position
  // dans la liste : une feuille où un simple manque décalerait tout, et on comparerait le
  // troisième simple au quatrième — en produisant quatre écarts là où il n'y en a qu'un.
  const parOrdre = new Map<number, TieLine>();
  for (const l of sheet.lines) {
    const n = ordreDe(l.label);
    if (n !== null && (l.a || l.b)) parOrdre.set(n, l);
  }

  for (const n of ours) {
    const l = parOrdre.get(n.order);
    if (!l) {
      problems.push(`Simple n° ${n.order} : absent de la feuille fédérale.`);
      continue;
    }
    const c = cotes(l, side);

    if (!memeJoueur(c.nous?.name, n.homeDisplayName)) {
      problems.push(
        `Simple n° ${n.order} : la ligue nous fait jouer « ${c.nous?.name ?? "personne"} », ` +
          `notre relevé dit « ${n.homeDisplayName} ».`,
      );
    }
    if (!memeJoueur(c.eux?.name, n.awayName)) {
      problems.push(
        `Simple n° ${n.order} : la ligue aligne en face « ${c.eux?.name ?? "personne"} », ` +
          `notre relevé dit « ${n.awayName} ».`,
      );
    }
    // Les jeux, et non le seul vainqueur : un 3-2 publié en 3-0 donne le même vainqueur mais pas
    // les mêmes points au classement — et c'est le classement qui décide de la montée.
    if (
      c.jeuxNous !== null &&
      c.jeuxEux !== null &&
      (c.jeuxNous !== n.gamesHome || c.jeuxEux !== n.gamesAway)
    ) {
      problems.push(
        `Simple n° ${n.order} : la ligue publie ${c.jeuxNous}-${c.jeuxEux} en jeux, ` +
          `notre relevé dit ${n.gamesHome}-${n.gamesAway}.`,
      );
    }
  }

  // Un simple que la ligue a saisi et que nous n'avons pas : l'inverse du cas précédent, et il
  // se dit aussi. C'est le symptôme d'une rencontre marquée à moitié dans l'appli.
  for (const [n] of parOrdre) {
    if (!ours.some((o) => o.order === n)) {
      problems.push(`Simple n° ${n} : saisi chez la ligue, absent de notre relevé.`);
    }
  }

  // « INCOMPLET » PLUTÔT QUE « DIVERGENT » quand il manque des simples chez la ligue : la
  // rencontre est en cours de saisie, ce qui n'est pas une anomalie. Les écarts déjà relevés
  // restent affichés — ils sont vrais — mais l'état ne crie pas.
  if (saisis.length < matchCount) {
    return { status: "partial", home, away, ...base, problems, side, url };
  }

  return {
    status: problems.length === 0 ? "match" : "diverges",
    home,
    away,
    ...base,
    problems,
    side,
    url,
  };
}

/** Ce que l'écran annonce en une phrase, sans avoir à réécrire la logique. */
export function describeOfficial(o: OfficialCheck): string {
  switch (o.status) {
    case "absent":
      return "Rencontre sans identifiant fédéral : la feuille officielle n'est pas atteignable.";
    case "unread":
      return "Feuille officielle non lue.";
    case "empty":
      return "La ligue n'a encore enregistré aucun simple.";
    case "partial":
      return `Saisie fédérale en cours : ${o.home ?? "?"}-${o.away ?? "?"} pour l'instant.`;
    case "match":
      return `La ligue publie ${o.home}-${o.away}, comme notre relevé.`;
    case "diverges":
      return `La ligue publie ${o.home ?? "?"}-${o.away ?? "?"} : ${o.problems.length} écart(s) avec notre relevé.`;
  }
}
