// Qui, sur NOTRE fiche d'équipe chez la fédération, est qui dans l'appli.
//
// ============================================================================
//  POURQUOI CE MODULE EXISTE — LE CLASSEMENT NATIONAL NE SUFFIT PAS.
//
//  Le rapprochement historique (`squashnet/refresh.ts`) interroge le CLASSEMENT
//  national (`ic_a=131079`). Or ce classement ne contient QUE les joueurs
//  classés. Mesuré le 2026-09-24 sur la fiche de Verrieres 4 : sur huit
//  inscrits, un seul (4D) est retrouvable ; les sept NC sont introuvables —
//  « DOXAT » rend zéro ligne, « BOUGARDIER » zéro, « CAGLIULI » zéro. Ils sont
//  pourtant licenciés, et parfaitement alignables.
//
//  Ce n'est donc pas un réglage à ajuster : `matchGuestRanking` ne PEUT PAS
//  rapprocher un NC, faute de ligne à rapprocher. Un club de loisir en compte
//  une majorité, et chacun demandait jusqu'ici une saisie manuelle
//  (`interclubCltOverride`), à refaire saison après saison.
//
//  LA FICHE D'ÉQUIPE (`ic_a=393480`, `squashnet/roster.ts`), elle, publie TOUS
//  les inscrits, NC compris, avec leur licence et leur classement. C'est la
//  source que ce module apparie.
//
//  IL EST PUR : aucun Prisma, aucun réseau. Même partage qu'entre
//  `interclub-opponents.ts` (la règle) et `interclub-opponents-db.ts` (la
//  lecture) — l'écran importe la règle, jamais la requête.
// ============================================================================

import { classementPower, isNC } from "./interclub-order";
import { nameKey } from "./squashnet/roster";
import type { RosterPlayer, TeamRoster } from "./squashnet/roster";

/** Un joueur de l'appli, membre ou invité, tel que l'appariement a besoin de le connaître. */
export interface JoueurAppli {
  kind: "member" | "guest";
  id: string;
  /** Nom affiché. L'ordre des mots n'a pas d'importance : `nameKey` le plie. */
  name: string;
  /**
   * Licence déjà rapprochée, ou null. C'est une PREUVE quand elle est là : un joueur dont la
   * licence est connue et différente n'est jamais candidat à une ligne, quel que soit son nom.
   */
  licence: string | null;
}

/** Ce qu'on a pu conclure d'une ligne de la fiche fédérale. */
export type Appariement =
  /** Un seul joueur de l'appli, et on sait pourquoi. */
  | { statut: "lie"; joueur: JoueurAppli; par: "licence" | "nom" }
  /**
   * Plusieurs joueurs possibles — homonymes dans l'équipe, ou deux lignes fédérales qui
   * désignent le même nom. ON NE TRANCHE PAS : c'est la règle d'or de `matchRanking`, et pour la
   * même raison. Un mauvais rapprochement pose un classement faux sur quelqu'un, et personne ne
   * va le vérifier.
   */
  | { statut: "ambigu"; candidats: JoueurAppli[] }
  /** Personne. C'est le cas normal d'un joueur que le club n'a pas encore inscrit dans l'appli. */
  | { statut: "inconnu" };

export interface LigneFederale {
  player: RosterPlayer;
  appariement: Appariement;
}

/** Licence comparable : les espaces et la casse ne font pas partie du numéro. */
function cleLicence(v: string | null | undefined): string {
  return (v ?? "").trim().toUpperCase();
}

/**
 * Le classement à retenir d'une ligne fédérale, ou null.
 *
 * VALIDÉ CONTRE LA LISTE FERMÉE (`classementPower`), et pas seulement recopié. La fédération
 * pourrait publier demain une valeur que l'ordre des simples ne sait pas comparer ; l'écrire
 * telle quelle rendrait le joueur inalignable un soir de rencontre, avec un message opaque. Mieux
 * vaut ne rien savoir de son classement — l'admin le corrige alors comme il l'a toujours fait.
 */
export function cltUtile(p: RosterPlayer): string | null {
  const v = (p.clt ?? "").trim().toUpperCase();
  if (!v) return null;
  return classementPower(v) === null ? null : v;
}

/**
 * Le rang mixte à retenir, ou null.
 *
 * ⚠️ TOUS LES NC PORTENT 9311, ET CE N'EST PAS UN RANG. C'est une SENTINELLE « non classé » :
 * vérifié sur les sept NC de la fiche de Verrieres 4, tous à la même valeur, au même moment.
 * L'écrire comme un rang placerait ces joueurs au 9311e rang national — un nombre qui a l'air
 * d'un fait, qui se trie, et qui s'afficherait à l'annuaire.
 *
 * On ne teste pas 9311 : on teste `isNC`, qui est la RAISON. La fédération n'ordonne pas les NC
 * entre eux (cf. `interclub-order.ts`), et un NC est alignable sans rang — la sentinelle n'a donc
 * rien à remplacer. Un classement inconnu ne rend pas de rang non plus : sans classement, le
 * joueur n'est de toute façon pas ordonnable, et un rang seul ne ferait que le laisser croire.
 */
export function rangMUtile(p: RosterPlayer): number | null {
  const clt = cltUtile(p);
  if (clt === null || isNC(clt)) return null;
  return typeof p.rangM === "number" && p.rangM > 0 ? p.rangM : null;
}

/**
 * La fiche fédérale, ligne par ligne, appariée aux joueurs de l'appli.
 *
 * DEUX CLÉS, DANS CET ORDRE.
 *
 *  1. LA LICENCE. Identifiant fédéral : indépendant du club, de l'orthographe et des homonymes.
 *     C'est elle qu'on cherche à poser partout, précisément pour que tout ce qui suit cesse de
 *     dépendre du nom.
 *  2. LE NOM, via `nameKey` — insensible à la casse, aux accents et à L'ORDRE DES MOTS. La
 *     fédération écrit « POPULU AXEL », l'appli « Axel Populu » ; sans ce pliage, aucune ligne ne
 *     se rapprocherait jamais.
 *
 * UNE LICENCE CONNUE ET DIFFÉRENTE DISQUALIFIE. Deux frères, deux homonymes : dès que l'un des
 * deux porte une licence, il cesse d'être candidat aux lignes des autres. C'est ce qui fait que le
 * rapprochement se resserre à mesure qu'on le fait, au lieu de rester aussi flou chaque saison.
 *
 * L'AMBIGUÏTÉ SE LIT DANS LES DEUX SENS, et c'est le piège que ce module a été écrit pour éviter.
 * Deux lignes fédérales peuvent désigner le même joueur de l'appli — deux licenciés homonymes
 * dont un seul a un compte. Chacune prise isolément conclurait « lié », et le même joueur serait
 * apparié deux fois. Un appariement par NOM n'est donc retenu que si sa cible n'est convoitée par
 * aucune autre ligne. L'appariement par LICENCE, lui, est une preuve : il n'est jamais remis en
 * cause.
 */
export function rapprocherRoster(
  roster: TeamRoster,
  joueurs: readonly JoueurAppli[],
): LigneFederale[] {
  const parLicence = new Map<string, JoueurAppli[]>();
  const parNom = new Map<string, JoueurAppli[]>();
  for (const j of joueurs) {
    const lic = cleLicence(j.licence);
    if (lic) pousser(parLicence, lic, j);
    const cle = nameKey(j.name);
    if (cle) pousser(parNom, cle, j);
  }

  // Premier tour : ce que chaque ligne CROIT pouvoir conclure, sans regarder les autres.
  const brut = roster.players.map((player) => {
    const lic = cleLicence(player.licence);
    const parLic = lic ? (parLicence.get(lic) ?? []) : [];
    // Une licence portée par deux joueurs de l'appli est une incohérence de NOS données, pas de
    // celles de la fédération — on ne tranche pas davantage que sur un homonyme.
    if (parLic.length === 1) {
      return { player, licence: parLic[0], candidats: [] as JoueurAppli[] };
    }
    if (parLic.length > 1) return { player, licence: null, candidats: parLic };

    const cle = nameKey(player.name);
    // Écarte ceux dont la licence est CONNUE et différente : la fédération a déjà dit qu'ils ne
    // sont pas cette personne-là.
    const candidats = (cle ? (parNom.get(cle) ?? []) : []).filter((j) => {
      const l = cleLicence(j.licence);
      return l === "" || l === lic;
    });
    return { player, licence: null, candidats };
  });

  // Second tour : un joueur convoité par PLUSIEURS lignes (par le nom) n'est attribué à aucune.
  const convoitises = new Map<string, number>();
  for (const b of brut) {
    if (b.licence || b.candidats.length !== 1) continue;
    const k = idDe(b.candidats[0]);
    convoitises.set(k, (convoitises.get(k) ?? 0) + 1);
  }

  return brut.map(({ player, licence, candidats }): LigneFederale => {
    if (licence) {
      return { player, appariement: { statut: "lie", joueur: licence, par: "licence" } };
    }
    if (candidats.length === 0) return { player, appariement: { statut: "inconnu" } };
    if (candidats.length === 1 && (convoitises.get(idDe(candidats[0])) ?? 0) === 1) {
      return { player, appariement: { statut: "lie", joueur: candidats[0], par: "nom" } };
    }
    return { player, appariement: { statut: "ambigu", candidats } };
  });
}

/**
 * Les joueurs de l'appli que la fiche fédérale NE PORTE PAS.
 *
 * Ce n'est pas une erreur de rapprochement : c'est presque toujours une déclaration oubliée avant
 * la date limite d'engagement, donc un joueur qui sera refusé sur la feuille de match. On le dit,
 * et on ne touche à rien — la fiche fédérale peut aussi être simplement en retard sur le club.
 *
 * Même appariement que `rapprocherRoster`, dans l'autre sens : licence d'abord, nom ensuite.
 */
export function absentsDuRoster(
  roster: TeamRoster,
  joueurs: readonly JoueurAppli[],
): JoueurAppli[] {
  const licences = new Set(roster.players.map((p) => cleLicence(p.licence)).filter(Boolean));
  const noms = new Set(roster.players.map((p) => nameKey(p.name)).filter(Boolean));
  return joueurs.filter((j) => {
    const lic = cleLicence(j.licence);
    if (lic) {
      // Une licence connue tranche seule, dans les deux sens : présente, le joueur est inscrit ;
      // absente, il ne l'est pas. Repasser par le nom ne ferait que rattraper un homonyme et
      // masquer précisément l'oubli qu'on cherche à signaler.
      return !licences.has(lic);
    }
    const cle = nameKey(j.name);
    return !(cle && noms.has(cle));
  });
}

function pousser(m: Map<string, JoueurAppli[]>, cle: string, j: JoueurAppli): void {
  const liste = m.get(cle);
  if (liste) liste.push(j);
  else m.set(cle, [j]);
}

/** Membres et invités vivent dans deux tables : leurs identifiants peuvent coïncider. */
function idDe(j: JoueurAppli): string {
  return `${j.kind}:${j.id}`;
}

/** Le même joueur, des deux côtés du roster : un invité, et le compte qu'il vient de créer. */
export interface Doublon {
  membre: JoueurAppli;
  invite: JoueurAppli;
  par: "licence" | "nom";
}

/**
 * Les joueurs présents DEUX FOIS dans l'équipe — une fois comme invité, une fois comme membre.
 *
 * ⚠️ CE CAS ARRIVE TOUT SEUL, ET C'EST LE CYCLE NORMAL. On inscrit au roster, depuis la fiche
 * fédérale, un joueur qui n'a pas de compte : il devient un invité. Puis un jour il ouvre
 * l'appli, et un admin le rattache à son équipe. L'équipe le porte alors deux fois, et le menu
 * de composition le propose deux fois — avec, en prime, deux classements qui peuvent diverger.
 *
 * On ne fusionne RIEN ici : ce module est pur, et la fusion touche des rencontres. On dit
 * seulement qui est qui, et l'admin tranche (cf. `promote_guest`).
 *
 * Même hiérarchie de preuves que `rapprocherRoster` : la licence d'abord, le nom ensuite, et un
 * nom ne conclut que s'il ne désigne qu'un seul candidat de chaque côté — deux homonymes sont
 * précisément le cas où une fusion automatique effacerait la mauvaise personne.
 */
export function doublonsAppli(joueurs: readonly JoueurAppli[]): Doublon[] {
  const membres = joueurs.filter((j) => j.kind === "member");
  const invites = joueurs.filter((j) => j.kind === "guest");
  const doublons: Doublon[] = [];
  const prisInvites = new Set<string>();

  for (const membre of membres) {
    const lic = cleLicence(membre.licence);
    if (lic) {
      const parLic = invites.filter((g) => cleLicence(g.licence) === lic);
      if (parLic.length === 1 && !prisInvites.has(parLic[0].id)) {
        prisInvites.add(parLic[0].id);
        doublons.push({ membre, invite: parLic[0], par: "licence" });
        continue;
      }
      // Licence connue des deux côtés et différente : ce sont deux personnes, et le nom n'y
      // changera rien. On s'arrête là plutôt que de retomber sur une homonymie.
      if (invites.some((g) => cleLicence(g.licence) !== "" && cleLicence(g.licence) !== lic)) {
        if (parLic.length === 0) continue;
      }
    }

    const cle = nameKey(membre.name);
    if (!cle) continue;
    // Un invité dont la licence est connue et différente de celle du membre n'est pas lui.
    const parNom = invites.filter(
      (g) =>
        nameKey(g.name) === cle &&
        !prisInvites.has(g.id) &&
        (lic === "" || cleLicence(g.licence) === "" || cleLicence(g.licence) === lic),
    );
    // Deux membres homonymes rendraient le rapprochement arbitraire : on ne conclut que si le
    // nom ne désigne qu'une personne DE CHAQUE CÔTÉ.
    const membresDuNom = membres.filter((m) => nameKey(m.name) === cle);
    if (parNom.length === 1 && membresDuNom.length === 1) {
      prisInvites.add(parNom[0].id);
      doublons.push({ membre, invite: parNom[0], par: "nom" });
    }
  }
  return doublons;
}
