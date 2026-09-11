import { UNSET_PLAYER } from "./interclub";
import { compareRosterOrder, isNC, lineupOrderConflict } from "./interclub-order";
import { normalize } from "./squashnet/match";
import { nameKey, type TeamRoster } from "./squashnet/roster";
import { lireRapport } from "./captain-check";

// ============================================================================
//  CE QU'ON SAIT DES JOUEURS D'EN FACE — sans rien demander à la fédération.
//
//  LE PROBLÈME : le nom d'un adversaire est un TEXTE LIBRE, recopié à la main
//  sur une feuille de match, un soir, sur un téléphone. « Detry » un mois,
//  « détry  » le suivant, « DETRY » le troisième : trois joueurs pour l'appli,
//  un seul en vrai. Le rapprochement fédéral échoue alors sur un accent, et le
//  capitaine se retrouve devant un formulaire qui refuse un nom parfaitement
//  réel.
//
//  ⚠️ CE MODULE NE CORRIGE PAS LES FAUTES DE FRAPPE, et ne le prétend pas :
//  « Detri » restera un joueur distinct de « Detry ». Il replie la casse, les
//  accents et les espaces — rien de plus. C'est le MENU qui traite la faute de
//  frappe, en la rendant inutile : on ne retape plus un nom déjà connu.
//
//  CE MODULE NE TÉLÉCHARGE RIEN LUI-MÊME. Tout ce qu'il fusionne lui est
//  DONNÉ, et vient de trois endroits, du plus sûr au plus approximatif :
//
//   * LE ROSTER FÉDÉRAL (`SquashnetTeamRoster`, lu sur `ic_a=393480`) — les
//     joueurs que le club adverse a INSCRITS dans cette équipe, avec leur
//     licence, leur classement et leur rang mixte. La fédération les donne :
//     il n'y a rien à rapprocher, donc rien qui puisse se tromper d'homonyme ;
//   * `InterclubOfficial.checkJson` — le rapport de vérification du capitaine,
//     qui porte la même identité, mais RAPPROCHÉE par le nom. Sûre à une
//     orthographe près ;
//   * `InterclubMatch.awayName` — tous les adversaires jamais alignés contre
//     nous. Un nom, rien de plus.
//
//  Chacun enrichit le suivant, et le roster prime : un adversaire connu de la
//  ligue est une entrée sûre, proposée dans un menu, qu'on n'a jamais à taper —
//  et dont on connaît le classement, donc l'ordre qu'il doit tenir. C'est ce
//  qui rend le menu utile DÈS LA PREMIÈRE RENCONTRE contre un club, là où les
//  deux autres sources demandaient de l'avoir déjà affronté.
//
//  CE MODULE EST PUR — aucun import de prisma ni de next/server, comme
//  `interclub-order.ts`. C'est ce qui permet à l'ÉCRAN d'employer exactement la
//  règle que le serveur applique : le sélecteur d'adversaire grise ce que la
//  route refuserait, au lieu de laisser composer pour se faire refuser ensuite.
//  Les lectures en base vivent à côté, dans `interclub-opponents-db.ts`.
//
//  ⚠️ LE ROSTER EST CELUI DES INSCRITS, PAS DES ALIGNÉS. Un club inscrit son
//  effectif en début de saison ; qui joue tel soir n'en dépend pas. Un joueur
//  aligné contre nous et absent de la liste EXISTE (mutation tardive,
//  inscription oubliée) — et une rencontre dont l'import n'a pas posé le
//  `snOpponentTeamId` n'a aucun roster du tout. La SAISIE LIBRE reste donc
//  atteignable : la retirer rendrait impossible d'enregistrer la moitié d'une
//  première rencontre.
// ============================================================================

/** Un adversaire déjà rencontré, et ce qu'on a fini par apprendre de lui. */
export interface KnownOpponent {
  /**
   * Le nom SAISI, tel qu'il a été retenu. C'est la valeur qu'on réécrira dans le champ, donc
   * celle qui doit rester stable d'une rencontre à l'autre — c'est tout l'objet du menu.
   */
  name: string;
  /** L'équipe contre laquelle on l'a vu (`Interclub.opponent`). */
  team: string;
  /** Nom tel que la fédération l'écrit, quand une vérification l'a confirmé. */
  fedName: string | null;
  clt: string | null;
  rangM: number | null;
  licence: string | null;
  /**
   * Nombre de rencontres où on l'a croisé. ZÉRO pour un joueur qu'on connaît par le ROSTER sans
   * l'avoir jamais rencontré : il est proposable, et son classement est sûr, mais on ne l'a
   * jamais vu jouer.
   *
   * ⚠️ NE TRIE PLUS LE MENU. Les habitués y remontaient, ce qui avait un sens quand la liste ne
   * contenait que des joueurs déjà rencontrés et pour la plupart sans classement. Le menu suit
   * désormais l'ORDRE DU CLASSEMENT, c'est-à-dire celui dans lequel ces joueurs devront
   * disputer les simples. Ce compteur reste exposé — il dit à qui le lit si l'adversaire est
   * une tête connue —, il ne décide plus de la place.
   */
  seen: number;
  /**
   * D'où vient ce qu'on sait de son CLASSEMENT — la question qu'un capitaine finit toujours
   * par poser devant un grisage qu'il ne comprend pas.
   *
   *  * `roster` — la fédération l'a inscrit dans cette équipe et publie sa licence, son
   *    classement et son rang mixte. Rien n'a été deviné ;
   *  * `check`  — une vérification de rencontre a RAPPROCHÉ son nom au classement fédéral. Sûr
   *    à une orthographe près, et daté de cette vérification ;
   *  * `sheet`  — un nom lu sur une feuille de match, rien de plus. Aucun classement, donc
   *    aucun ordre des simples vérifiable sur lui.
   */
  source: "roster" | "check" | "sheet";
}

/** Une rencontre passée, réduite à ce que ce module lit. */
export interface OpponentSource {
  opponent: string;
  matches: { awayName: string }[];
  checkJson: string | null;
  /**
   * `teamid` fédéral de l'adversaire, quand l'import du calendrier l'a posé. C'est la clé du
   * roster : sans lui, on retombe sur ce qu'on savait déjà — nos propres feuilles de match.
   */
  snOpponentTeamId?: string | null;
}

/**
 * Ce nom désigne-t-il quelqu'un ? Un champ vide et le placeholder « À désigner » n'ont ni l'un ni
 * l'autre leur place dans un menu d'adversaires, et aucun ordre à respecter.
 *
 * La comparaison passe par `normalize` (la même que le rapprochement fédéral) : un « a designer »
 * saisi à la main est le même non-joueur que le placeholder, et l'inscrire comme adversaire
 * ferait apparaître « À désigner » dans le menu de la rencontre suivante.
 */
export function estDesigne(name: string | null | undefined): boolean {
  const n = normalize(name ?? "");
  return !!n && n !== normalize(UNSET_PLAYER);
}

/**
 * Fusionne les rencontres passées en une liste d'adversaires connus. PURE et testée.
 *
 * TROIS DÉCISIONS DE FUSION, et elles se voient toutes à l'usage :
 *
 *  1. LA CLÉ EST LE NOM, PAR ÉQUIPE, INSENSIBLE À L'ORDRE DES MOTS (`nameKey`). « Détry » et
 *     « detry » sont le même joueur, et les proposer deux fois ramènerait exactement le
 *     problème que le menu résout. L'ordre des mots compte pour la même raison, et elle est
 *     nouvelle : la fédération écrit « DETRY XAVIER », une feuille de match « Xavier Détry ».
 *     Sans cette clé, le roster n'enrichirait JAMAIS un nom déjà saisi — on afficherait le même
 *     joueur deux fois, l'un classé et l'autre pas.
 *  2. LE NOM RETENU EST LE PLUS RÉCEMMENT SAISI, et l'identité fédérale la plus SÛRE. Le plus
 *     récent parce qu'il reflète la dernière correction faite à la main, et parce qu'un nom qui
 *     change sous les doigts du capitaine au milieu d'une saison rendrait le menu déroutant.
 *  3. LE ROSTER PRIME SUR LA VÉRIFICATION, qui prime sur rien. Une inscription fédérale ne se
 *     trompe pas d'homonyme ; un rapprochement par le nom, si. Et une vérification qui a abouti
 *     une fois vaut mieux que trois qui n'ont rien conclu — une seule suffit à connaître le
 *     classement, donc à faire respecter l'ordre des simples.
 *
 * L'ordre d'entrée compte : les rencontres doivent arriver de la PLUS ANCIENNE à la plus
 * récente, pour que « le plus récent » veuille dire quelque chose.
 *
 * `rosters` est indexé par `snTeamId` — l'identifiant, jamais le nom : le nom d'équipe porte un
 * numéro (« Verrieres 2 »), change de casse d'une saison à l'autre, et deux clubs d'un même
 * réseau ne diffèrent que par un chiffre. Absent, ce paramètre ne retire rien : on retombe
 * exactement sur ce que le module savait avant lui.
 */
export function mergeOpponents(
  sources: OpponentSource[],
  rosters: ReadonlyMap<string, TeamRoster> = new Map(),
): KnownOpponent[] {
  const parCle = new Map<string, KnownOpponent>();
  const cleDe = (equipe: string, nom: string) => `${normalize(equipe)}|${nameKey(nom)}`;

  // ---- 1. LE ROSTER FÉDÉRAL, quand on l'a --------------------------------
  //
  // POSÉ EN PREMIER, et c'est ce qui rend le menu utile dès la première rencontre : ces joueurs
  // n'ont pas eu à être croisés pour être connus. Une équipe jamais affrontée cesse d'ouvrir un
  // champ vide, et son ordre des simples devient vérifiable le soir même.
  //
  // Une seule ligne de roster par ÉQUIPE, même si cinq rencontres la désignent : on itère donc
  // sur les équipes distinctes, pas sur les rencontres.
  const rosterParEquipe = new Map<string, TeamRoster>();
  for (const src of sources) {
    const r = src.snOpponentTeamId ? rosters.get(src.snOpponentTeamId) : undefined;
    // Le PREMIER l'emporte, comme pour le nom d'équipe : deux rencontres contre le même club
    // portent le même identifiant, donc le même roster.
    if (r && !rosterParEquipe.has(normalize(src.opponent))) {
      rosterParEquipe.set(normalize(src.opponent), r);
    }
  }
  for (const src of sources) {
    const roster = rosterParEquipe.get(normalize(src.opponent));
    if (!roster) continue;
    for (const p of roster.players) {
      const cle = cleDe(src.opponent, p.name);
      if (parCle.has(cle)) continue; // déjà posé par une autre rencontre contre cette équipe
      parCle.set(cle, {
        // Le nom FÉDÉRAL : c'est exactement ce qu'un capitaine devra recopier sur le formulaire
        // de la ligue. Un nom jamais saisi chez nous n'a pas d'autre orthographe à respecter.
        name: p.name,
        team: src.opponent,
        fedName: p.name,
        clt: p.clt,
        rangM: p.rangM,
        licence: p.licence,
        seen: 0,
        source: "roster",
      });
    }
  }

  // ---- 2. NOS PROPRES FEUILLES DE MATCH -----------------------------------
  for (const src of sources) {
    const rapport = lireRapport(src.checkJson);
    // Le rapport indexe ses joueurs par clé de nom : c'est ainsi qu'on raccroche une identité
    // fédérale à un nom saisi, sans dépendre de l'ordre des simples (qui peut avoir changé
    // entre la vérification et aujourd'hui).
    const fede = new Map(
      (rapport?.players ?? [])
        .filter((p) => p.side === "away" && p.verdict === "found")
        .map((p) => [nameKey(p.name), p]),
    );

    for (const m of src.matches) {
      const nom = m.awayName?.trim() ?? "";
      // Un nom vide ou un simple non composé n'est pas un joueur.
      if (!estDesigne(nom)) continue;

      const cle = cleDe(src.opponent, nom);
      const avant = parCle.get(cle);
      const confirme = fede.get(nameKey(nom));
      // Le roster prime sur tout : la fédération nous a DONNÉ ce joueur, là où une vérification
      // a dû le rapprocher. Un rapprochement se trompe sur un homonyme ; une inscription, non.
      const duRoster = avant?.source === "roster";

      parCle.set(cle, {
        // Le nom retenu est le plus RÉCEMMENT SAISI — les sources arrivent dans l'ordre
        // chronologique, donc écraser suffit. Il l'emporte même sur le nom fédéral : c'est
        // celui qu'on réécrira dans le champ, et le faire changer sous les doigts du capitaine
        // au milieu d'une saison rendrait le menu déroutant. L'orthographe de la ligue reste
        // lisible à côté, dans `fedName`.
        name: nom,
        team: src.opponent,
        // La plus RICHE : une identité déjà connue ne se perd pas parce qu'une vérification
        // ultérieure n'a rien conclu (squashnet muet, joueur momentanément introuvable…).
        fedName: (duRoster ? avant.fedName : null) ?? confirme?.fedName ?? avant?.fedName ?? null,
        clt: (duRoster ? avant.clt : null) ?? confirme?.clt ?? avant?.clt ?? null,
        rangM: (duRoster ? avant.rangM : null) ?? confirme?.rangM ?? avant?.rangM ?? null,
        licence: (duRoster ? avant.licence : null) ?? confirme?.licence ?? avant?.licence ?? null,
        seen: (avant?.seen ?? 0) + 1,
        source: duRoster ? "roster" : confirme || avant?.source === "check" ? "check" : "sheet",
      });
    }
  }

  // DANS L'ORDRE DU CLASSEMENT — le mieux classé en tête, comme le sélecteur de NOTRE
  // composition. La liste se lit donc dans l'ordre où ces joueurs devront disputer les simples,
  // ce qui est précisément la question qu'on se pose en composant : qui est leur n° 1 ?
  //
  // `compareRosterOrder` n'est PAS réécrit ici. C'est celui de notre propre roster, et ses deux
  // paliers sont les critères mêmes de la règle fédérale (classement, puis rang mixte à
  // classement égal). Deux comparateurs finiraient par diverger, et l'un des deux trierait un
  // jour les adversaires autrement que les nôtres — sur une règle qui vaut pour les deux camps.
  //
  // LES NON-CLASSÉS TOMBENT EN FIN DE LISTE, palier que `compareRosterOrder` tient déjà : ce
  // sont les seuls sur lesquels aucun ordre des simples ne peut être vérifié, donc les seuls
  // qu'on ne peut pas situer parmi les autres.
  //
  // `seen` NE TRIE PLUS. Les habitués remontaient en tête, ce qui avait un sens quand la liste
  // ne contenait que des joueurs déjà rencontrés et pour la plupart sans classement. Depuis que
  // le roster fédéral l'alimente, la question n'est plus « qui revient souvent » mais « qui est
  // devant qui » — et mêler les deux critères produirait un ordre que rien n'explique.
  //
  // L'alphabet reste le dernier recours, pour que la liste ne bouge pas d'un chargement à
  // l'autre : `compareRosterOrder` rend 0 sur deux joueurs qu'il ne sait pas départager.
  return [...parCle.values()].sort(
    (a, b) =>
      compareRosterOrder(a, b) || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  );
}

/**
 * Les équipes déjà rencontrées, dans l'ordre alphabétique.
 *
 * C'est la liste du menu « équipe adverse ». Après un import de calendrier, elle contient
 * EXACTEMENT les équipes de la poule que nous affrontons — la fédération publie nos cinq
 * rencontres, donc nos cinq adversaires. Aucune requête n'est nécessaire pour l'établir : le
 * calendrier importé la porte déjà.
 */
export function opponentTeams(sources: { opponent: string }[]): string[] {
  const parCle = new Map<string, string>();
  for (const s of sources) {
    const nom = s.opponent?.trim() ?? "";
    // Le PREMIER l'emporte — l'inverse du nom d'un JOUEUR, et pour une raison précise : un nom
    // d'équipe n'est jamais corrigé à la main, il est estampillé par l'import du calendrier
    // fédéral. Une variante ultérieure (« chaville 4 » saisi à la main) est donc une dégradation
    // de l'orthographe officielle, pas une correction — la laisser gagner ferait afficher au menu
    // ce que la fédération n'écrit pas.
    if (nom && !parCle.has(normalize(nom))) parCle.set(normalize(nom), nom);
  }
  return [...parCle.values()].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}

// --- L'ordre des simples adverses, à la composition -------------------------

/**
 * L'ordre des simples d'en face est-il rompu ? Rendu comme un message de refus, ou `null`.
 *
 * LA RÈGLE N'EST PAS RÉÉCRITE : elle appartient à `lineupOrderConflict`, celle-là même qui
 * refuse notre propre composition. Le mieux classé joue le simple n° 1, et à classement égal le
 * meilleur rang mixte passe devant — pour les deux équipes, une rencontre disputée dans le
 * mauvais ordre étant sanctionnable des deux côtés.
 *
 * ⚠️ ON NE REFUSE QUE CE QU'ON CONNAÎT, et c'est la différence irréductible avec notre camp.
 * Le classement d'un adversaire ne nous est pas donné : il vient de nos rencontres passées, une
 * fois qu'un capitaine les a vérifiées. `lineupOrderConflict` refuse un joueur sans classement —
 * ce qui est juste chez nous (un admin peut le renseigner) et absurde en face : cela rendrait
 * impossible d'inscrire une première rencontre contre un club jamais croisé, c'est-à-dire le cas
 * le plus banal d'un début de saison.
 *
 * Donc : dès qu'UN adversaire désigné manque à l'appel, on ne conclut rien. Quand ils sont tous
 * connus, le refus est le même que le nôtre, au préfixe près — qui dit d'où vient le verdict,
 * parce qu'un capitaine refusé sur la composition d'en face doit comprendre pourquoi.
 */
export function awayLineupConflict(
  lines: readonly { order: number; awayName: string }[],
  known: readonly KnownOpponent[],
  opponent: string,
): string | null {
  // ⚠️ L'ÉQUIPE EST OBLIGATOIRE, ET C'EST UNE CORRECTION. `known` arrive de
  // `loadKnownOpponents(teamId)`, qui rend les adversaires de TOUS les clubs que notre équipe a
  // affrontés — c'est ce qu'il faut pour remplir un menu, jamais pour juger UNE composition.
  // La carte se construisait sur le seul nom : un « Paul Martin » de Chaville fournissait donc
  // son classement à un « Paul Martin » de Meudon, et la route refusait en 400 une composition
  // parfaitement régulière, sur un classement qui n'était pas le sien.
  //
  // `mergeOpponents` prend soin de séparer ces homonymes par équipe (c'est même un de ses
  // tests) : les refondre ici défaisait son travail. L'écran, lui, filtrait déjà sur l'équipe
  // avant d'appeler — d'où un serveur qui refusait ce que l'écran venait d'autoriser, l'inverse
  // exact de ce que ce module promet.
  //
  // La clé est INSENSIBLE À L'ORDRE DES MOTS (`nameKey`) : le roster fédéral écrit « POPULU
  // AXEL », la feuille de match « Axel Populu ». Avec `normalize` seule, un capitaine qui
  // choisit un joueur au menu du roster puis en retape un autre à la main verrait la garde
  // renoncer — « on ne conclut rien » — sur un joueur pourtant parfaitement connu.
  const cible = normalize(opponent);
  const parNom = new Map(
    known.filter((k) => normalize(k.team) === cible).map((k) => [nameKey(k.name), k]),
  );

  const designes = lines.filter((l) => estDesigne(l.awayName));
  // Un seul adversaire désigné ne peut violer aucun ordre : il n'y a personne à comparer.
  if (designes.length < 2) return null;

  const slots = [];
  for (const l of designes) {
    const k = parNom.get(nameKey(l.awayName));
    // Jamais rencontré, ou rencontré sans que la fédération l'ait confirmé : on ne sait pas où
    // il se situe, donc on ne refuse rien — ni pour lui, ni pour les autres.
    if (!k || !k.clt) return null;
    // Hors NC, le rang mixte départage les ex æquo. Sans lui, deux « 5A » dans le mauvais sens
    // passeraient pour conformes : mieux vaut se taire que valider à tort.
    if (!isNC(k.clt) && k.rangM == null) return null;
    slots.push({ order: l.order, name: k.fedName ?? k.name, clt: k.clt, rangM: k.rangM });
  }

  const conflit = lineupOrderConflict(slots);
  return conflit === null ? null : `Ordre des simples adverses — ${conflit}`;
}

// --- Un adversaire, un simple ----------------------------------------------

/**
 * Cet adversaire dispute-t-il DÉJÀ un autre simple de la rencontre ? Rend le numéro de ce
 * simple, ou `null`.
 *
 * LA MÊME RÈGLE QUE CHEZ NOUS, et ce n'est pas une symétrie décorative : le règlement interdit
 * à un joueur de disputer deux simples d'une même rencontre, des deux côtés du filet. Notre
 * camp la tient déjà (`findAlignmentClash`, `interclub-roster.ts`) ; en face, rien ne
 * l'empêchait — le même nom pouvait être inscrit sur les quatre simples, et la feuille de match
 * partait chez la ligue avec une composition qu'elle refuserait.
 *
 * ⚠️ LA COMPARAISON SE FAIT SUR LE NOM, faute de mieux : un adversaire n'a pas d'identifiant
 * chez nous (`InterclubMatch.awayName` est un texte libre, cf. l'en-tête de ce module). C'est la
 * différence irréductible avec notre camp, où le doublon se détecte sur `homeUserId` /
 * `homeGuestId` — deux clés que rien ne peut confondre.
 *
 * La clé est celle de tout le module (`nameKey`) : casse, accents et ORDRE DES MOTS repliés.
 * « DETRY XAVIER » choisi au menu du roster et « Xavier Détry » retapé à la main sont donc bien
 * le même joueur, ce qu'une comparaison littérale aurait manqué — et c'est précisément la faute
 * la plus probable, puisqu'elle vient d'avoir été tapée deux fois de deux façons.
 *
 * ⚠️ CE QU'ELLE NE SAIT PAS VOIR : une VRAIE faute de frappe. « Detri » et « Detry » restent
 * deux joueurs, ici comme ailleurs. On ne devine pas — et le menu est là pour que la question ne
 * se pose pas.
 *
 * « À désigner » ne bloque jamais rien : un simple non composé n'est pas un joueur, et le
 * refuser rendrait impossible de créer une rencontre (les quatre simples y naissent vides).
 */
export function awayAlignmentClash(
  siblings: readonly { order: number; awayName: string }[],
  candidate: { order: number; awayName: string },
): number | null {
  if (!estDesigne(candidate.awayName)) return null;
  const cle = nameKey(candidate.awayName);

  for (const l of siblings) {
    if (l.order === candidate.order) continue;
    if (!estDesigne(l.awayName)) continue;
    if (nameKey(l.awayName) === cle) return l.order;
  }
  return null;
}

/**
 * Le premier doublon d'une composition ADVERSE entière, rendu comme un message de refus.
 *
 * Le pendant de `awayLineupConflict` pour la règle « un adversaire, un simple » : celui-ci
 * contrôle la composition d'un coup (création d'une rencontre), là où `awayAlignmentClash`
 * répond sur UN simple qu'on retouche.
 */
export function awayLineupDuplicate(
  lines: readonly { order: number; awayName: string }[],
): string | null {
  const vus = new Map<string, { order: number; name: string }>();
  // Les simples sont parcourus dans l'ordre des NUMÉROS, pas dans celui du tableau reçu : le
  // message doit nommer les deux mêmes simples quel que soit l'ordre dans lequel le client les
  // a envoyés, sans quoi deux capitaines verraient deux messages différents pour une seule
  // faute.
  for (const l of [...lines].sort((a, b) => a.order - b.order)) {
    if (!estDesigne(l.awayName)) continue;
    const cle = nameKey(l.awayName);
    const avant = vus.get(cle);
    if (avant) {
      return (
        `Composition adverse — ${l.awayName} dispute déjà le simple n° ${avant.order} : ` +
        `un joueur ne peut pas disputer deux simples d'une même rencontre.`
      );
    }
    vus.set(cle, { order: l.order, name: l.awayName });
  }
  return null;
}
