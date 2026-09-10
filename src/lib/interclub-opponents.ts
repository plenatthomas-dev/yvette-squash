import { UNSET_PLAYER } from "./interclub";
import { isNC, lineupOrderConflict } from "./interclub-order";
import { normalize } from "./squashnet/match";
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
//  CE MODULE NE TÉLÉCHARGE RIEN. Tout ce qu'il rend est déjà en base, et vient
//  de deux endroits qu'on avait sans le savoir :
//
//   * `InterclubMatch.awayName` — tous les adversaires jamais alignés contre
//     nous, saisis rencontre après rencontre ;
//   * `InterclubOfficial.checkJson` — le rapport de vérification du capitaine,
//     qui porte pour chacun son NOM FÉDÉRAL, son classement, son rang et sa
//     licence, une fois que la fédération les a confirmés.
//
//  Le second ENRICHIT le premier. Un adversaire croisé puis vérifié devient
//  ainsi une entrée sûre, proposée dans un menu, qu'on n'a plus jamais à
//  retaper — et dont on connaît le classement, donc l'ordre qu'il doit tenir.
//
//  CE MODULE EST PUR — aucun import de prisma ni de next/server, comme
//  `interclub-order.ts`. C'est ce qui permet à l'ÉCRAN d'employer exactement la
//  règle que le serveur applique : le sélecteur d'adversaire grise ce que la
//  route refuserait, au lieu de laisser composer pour se faire refuser ensuite.
//  Les lectures en base vivent à côté, dans `interclub-opponents-db.ts`.
//
//  ⚠️ CE N'EST PAS LE ROSTER DE L'ÉQUIPE ADVERSE. C'est la liste de ceux qu'on
//  a DÉJÀ RENCONTRÉS. Un joueur qu'on croise pour la première fois n'y est pas,
//  et la saisie libre reste donc possible — la retirer rendrait impossible
//  d'enregistrer la moitié d'une première rencontre. Le vrai roster viendra de
//  la fiche d'équipe fédérale (`ic_a=393480`, cf. docs/squashnet.md), le jour
//  où son rendu aura pu être capté.
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
  /** Nombre de rencontres où on l'a croisé — les habitués remontent en tête du menu. */
  seen: number;
}

/** Une rencontre passée, réduite à ce que ce module lit. */
export interface OpponentSource {
  opponent: string;
  matches: { awayName: string }[];
  checkJson: string | null;
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
 * DEUX DÉCISIONS DE FUSION, et elles se voient à l'usage :
 *
 *  1. LA CLÉ EST LE NOM NORMALISÉ, PAR ÉQUIPE. « Détry » et « detry » sont le même joueur, et
 *     les proposer deux fois dans le menu ramènerait exactement le problème qu'il résout. La
 *     normalisation est celle du rapprochement fédéral (`normalize`) : accents pliés, casse et
 *     ponctuation neutralisées — donc la même notion d'identité que partout ailleurs.
 *  2. LE NOM RETENU EST LE PLUS RÉCENT, et l'identité fédérale la plus RICHE. Le plus récent
 *     parce qu'il reflète la dernière correction faite à la main ; la plus riche parce qu'une
 *     vérification qui a abouti une fois vaut mieux que trois qui n'ont rien conclu — une seule
 *     suffit à connaître le classement, donc à faire respecter l'ordre des simples.
 *
 * L'ordre d'entrée compte : les rencontres doivent arriver de la PLUS ANCIENNE à la plus
 * récente, pour que « le plus récent » veuille dire quelque chose.
 */
export function mergeOpponents(sources: OpponentSource[]): KnownOpponent[] {
  const parCle = new Map<string, KnownOpponent>();

  for (const src of sources) {
    const rapport = lireRapport(src.checkJson);
    // Le rapport indexe ses joueurs par nom normalisé : c'est ainsi qu'on raccroche une
    // identité fédérale à un nom saisi, sans dépendre de l'ordre des simples (qui peut avoir
    // changé entre la vérification et aujourd'hui).
    const fede = new Map(
      (rapport?.players ?? [])
        .filter((p) => p.side === "away" && p.verdict === "found")
        .map((p) => [normalize(p.name), p]),
    );

    for (const m of src.matches) {
      const nom = m.awayName?.trim() ?? "";
      // Un nom vide ou un simple non composé n'est pas un joueur.
      if (!estDesigne(nom)) continue;
      const norme = normalize(nom);

      const cle = `${normalize(src.opponent)}|${norme}`;
      const avant = parCle.get(cle);
      const confirme = fede.get(norme);

      parCle.set(cle, {
        // Le plus RÉCENT : les sources arrivent dans l'ordre chronologique, donc écraser suffit.
        name: nom,
        team: src.opponent,
        // La plus RICHE : une identité déjà connue ne se perd pas parce qu'une vérification
        // ultérieure n'a rien conclu (squashnet muet, joueur momentanément introuvable…).
        fedName: confirme?.fedName ?? avant?.fedName ?? null,
        clt: confirme?.clt ?? avant?.clt ?? null,
        rangM: confirme?.rangM ?? avant?.rangM ?? null,
        licence: confirme?.licence ?? avant?.licence ?? null,
        seen: (avant?.seen ?? 0) + 1,
      });
    }
  }

  // Les CONFIRMÉS d'abord — ce sont les seuls sur lesquels l'ordre des simples peut être
  // vérifié —, puis les plus souvent croisés, puis l'alphabet pour que la liste ne bouge pas
  // d'un chargement à l'autre.
  return [...parCle.values()].sort(
    (a, b) =>
      Number(!!b.clt) - Number(!!a.clt) ||
      b.seen - a.seen ||
      a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
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
): string | null {
  const parNom = new Map(known.map((k) => [normalize(k.name), k]));

  const designes = lines.filter((l) => estDesigne(l.awayName));
  // Un seul adversaire désigné ne peut violer aucun ordre : il n'y a personne à comparer.
  if (designes.length < 2) return null;

  const slots = [];
  for (const l of designes) {
    const k = parNom.get(normalize(l.awayName));
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
