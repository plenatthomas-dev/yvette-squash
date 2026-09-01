// Qui peut être aligné dans une rencontre, et comment un choix de composition se résout.
//
// POURQUOI CE MODULE EXISTE
// La règle du club est simple à dire — « seuls les joueurs de l'équipe qui dispute la rencontre
// peuvent être alignés » — et elle était appliquée à UN SEUL endroit (le PATCH d'un match). La
// création d'une rencontre acceptait n'importe quel identifiant de membre, et les deux routes
// acceptaient en plus un nom LIBRE : la règle ne tenait donc nulle part. Rassembler ici la
// définition du roster ET la résolution d'un choix garantit que les deux chemins d'écriture
// répondent à la même question de la même façon.
//
// Un roster mêle deux populations, et c'est le point important : les MEMBRES (compte sur
// l'appli, rattachés à une équipe par un admin) et les INVITÉS (`InterclubGuest` : ils jouent le
// championnat sans avoir jamais ouvert l'appli). Les deux sont des choix légitimes de
// composition ; ni l'un ni l'autre n'est un nom libre.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { MAX_PLAYER_NAME_LEN, UNSET_PLAYER } from "./interclub-db";
import { lineupOrderConflict, type OrderedSlot } from "./interclub-order";

/** Une entrée choisissable dans le sélecteur de composition. */
export interface RosterEntry {
  kind: "member" | "guest";
  id: string;
  name: string;
  /**
   * Classement effectif, ou `null` si inconnu. Pour un membre : la correction admin
   * (`User.interclubCltOverride`) si posée, sinon le dernier classement squashnet rapproché,
   * sinon `null`. Pour un invité : `InterclubGuest.clt`, saisi à la main (il n'a rien à
   * rapprocher). Sert à afficher le classement dans le sélecteur ET à faire respecter l'ordre
   * des simples (cf. `interclub-order.ts`).
   */
  clt: string | null;
  /**
   * Rang national MIXTE (`SquashnetRanking.rangM`), ou `null` si inconnu — TOUJOURS `null` pour
   * un invité (`InterclubGuest` n'a pas de rang, seulement un `clt` saisi à la main). Ne sert
   * PAS à l'ordre des simples (`interclub-order.ts` compare des CLASSEMENTS, jamais des rangs) :
   * uniquement à départager, dans le sélecteur, deux joueurs de MÊME classement — le mieux
   * classé au rang mixte le plus PETIT passe en tête (cf. `Interclub.tsx`, tri d'affichage).
   */
  rangM: number | null;
}

/**
 * Le choix tel qu'il arrive du client. `null` des deux côtés = « à désigner » — c'est un état
 * normal, pas une erreur : on inscrit souvent la rencontre avant de savoir qui joue.
 */
export interface HomePick {
  userId?: unknown;
  guestId?: unknown;
}

/** Ce qu'il faut écrire sur `InterclubMatch` une fois le choix résolu. */
export interface ResolvedPick {
  homeUserId: string | null;
  homeGuestId: string | null;
  /** Nom FIGÉ : supprimer un compte ou retirer un invité du roster n'efface pas qui a joué. */
  homeDisplayName: string;
  /**
   * Classement effectif au moment de la résolution — PAS figé (contrairement au nom) : il sert
   * uniquement à valider l'ORDRE des simples à l'écriture, jamais affiché ni stocké sur le
   * match. `null` pour un simple « à désigner », ou pour un joueur dont le classement n'est
   * pas connu (cf. `RosterEntry.clt`).
   */
  clt: string | null;
}

export type PickResult = { ok: true; value: ResolvedPick } | { ok: false; error: string };

/**
 * Client Prisma OU client de transaction. La résolution d'un choix se fait DANS la transaction
 * qui écrit le match (sinon on validerait contre un état déjà périmé), mais le même code sert
 * hors transaction à la création.
 */
type Db = Pick<Prisma.TransactionClient, "user" | "interclubGuest">;

/** Client minimal pour la recherche d'un doublon d'alignement. */
type MatchDb = Pick<Prisma.TransactionClient, "interclubMatch">;

/** Nom d'affichage d'un membre : le pseudo s'il en a choisi un, sinon son nom. */
function memberName(u: { displayName: string; nickname: string | null }): string {
  return u.nickname ?? u.displayName;
}

/**
 * Roster complet d'une équipe, trié par nom.
 *
 * Les comptes DÉSACTIVÉS sont exclus : un membre qu'un admin a désactivé ne joue plus, et le
 * proposer à la composition ne ferait qu'égarer le capitaine. Les rencontres passées gardent
 * son nom, qui y est figé.
 *
 * ⚠️ L'opt-out d'annuaire (`User.listed`) n'est PAS filtré ici, délibérément. Se retirer de
 * l'annuaire, c'est ne pas figurer dans le trombinoscope du club ; ce n'est pas quitter son
 * équipe. Filtrer dessus rendrait la composition impossible pour ces membres-là sans que
 * personne comprenne pourquoi le nom manque. La surface reste étroite : le roster n'est servi
 * qu'aux membres connectés, et seulement pour l'équipe qui dispute la rencontre ouverte.
 */
export async function teamRoster(teamId: string): Promise<RosterEntry[]> {
  const [members, guests] = await Promise.all([
    prisma.user.findMany({
      where: { teamId, disabledAt: null },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        interclubCltOverride: true,
        squashnetRanking: { select: { clt: true, rangM: true } },
      },
    }),
    prisma.interclubGuest.findMany({
      where: { teamId },
      select: { id: true, name: true, clt: true },
    }),
  ]);

  return [
    ...members.map((u) => ({
      kind: "member" as const,
      id: u.id,
      name: memberName(u),
      clt: memberClt(u),
      rangM: u.squashnetRanking?.rangM ?? null,
    })),
    ...guests.map((g) => ({
      kind: "guest" as const,
      id: g.id,
      name: g.name,
      clt: g.clt ?? null,
      rangM: null,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

/** Un membre d'équipe, plus l'équipe qui le retient — ce que l'écran d'admin doit pouvoir grouper. */
export interface TeamMemberEntry extends RosterEntry {
  teamId: string;
}

/**
 * TOUS les membres rattachés à une équipe, toutes équipes confondues — pour l'écran d'admin
 * « Équipes interclub », qui montre l'effectif RÉEL de chaque équipe (membres ET invités) avec
 * son classement, là où il ne montrait qu'un décompte.
 *
 * UNE seule requête, pas une par équipe : l'écran les affiche toutes ensemble, et un club a
 * assez peu d'équipes pour que la boucle passe inaperçue — mais assez de membres pour qu'un
 * aller-retour Neon par équipe se voie sur un cold start.
 *
 * Mêmes règles que `teamRoster` (comptes désactivés exclus, classement effectif via
 * `memberClt`), et pour la même raison : deux écrans qui répondent à « qui est dans cette
 * équipe, et à quel classement » ne doivent pas pouvoir diverger.
 */
export async function allTeamMembers(): Promise<TeamMemberEntry[]> {
  const members = await prisma.user.findMany({
    where: { teamId: { not: null }, disabledAt: null },
    select: {
      id: true,
      teamId: true,
      displayName: true,
      nickname: true,
      interclubCltOverride: true,
      squashnetRanking: { select: { clt: true, rangM: true } },
    },
  });

  return members
    .map((u) => ({
      kind: "member" as const,
      id: u.id,
      // Non-nul : le `where` ci-dessus exclut les membres sans équipe.
      teamId: u.teamId as string,
      name: memberName(u),
      clt: memberClt(u),
      rangM: u.squashnetRanking?.rangM ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

/**
 * Classement effectif d'un membre : la correction admin si posée, sinon le dernier
 * rapprochement squashnet. PRIORITÉ à la correction — c'est tout son objet : corriger un
 * rapprochement qui s'est trompé (nom mal orthographié côté ResaMania, licence pas encore
 * rapprochée…) sans attendre que squashnet se corrige de lui-même le mois suivant.
 */
function memberClt(u: { interclubCltOverride: string | null; squashnetRanking: { clt: string } | null }): string | null {
  return u.interclubCltOverride ?? u.squashnetRanking?.clt ?? null;
}

/**
 * Le joueur est-il DÉJÀ aligné sur un autre simple de la même rencontre ?
 *
 * Un joueur ne dispute qu'un simple par rencontre : c'est une règle de la compétition, pas une
 * préférence d'affichage. La création la faisait déjà respecter, mais seulement à l'intérieur
 * du formulaire qu'elle recevait ; la modification d'un match, elle, ne regardait rien. Il
 * suffisait donc de composer la rencontre puis de rouvrir un simple pour y remettre quelqu'un
 * qui jouait déjà — l'écran le proposait, et le serveur l'acceptait.
 *
 * Renvoie le NUMÉRO du simple en conflit (pour pouvoir le nommer dans le message), ou `null`.
 * « À désigner » n'est jamais un conflit : c'est l'état par défaut de tous les simples encore
 * à composer.
 *
 * À appeler DANS la transaction qui écrit : hors transaction, deux capitaines alignant le même
 * joueur au même instant passeraient tous les deux le contrôle.
 */
export async function findAlignmentClash(
  db: MatchDb,
  fixtureId: string,
  exceptMatchId: string,
  pick: Pick<ResolvedPick, "homeUserId" | "homeGuestId">,
): Promise<number | null> {
  const who = pick.homeUserId
    ? { homeUserId: pick.homeUserId }
    : pick.homeGuestId
      ? { homeGuestId: pick.homeGuestId }
      : null;
  if (!who) return null;

  const clash = await db.interclubMatch.findFirst({
    where: { interclubId: fixtureId, id: { not: exceptMatchId }, ...who },
    select: { order: true },
  });
  return clash?.order ?? null;
}

/**
 * Résout un choix de composition contre l'équipe qui dispute RÉELLEMENT la rencontre.
 *
 * C'est ici que la règle du club est appliquée, et le contrôle porte sur `teamId` lu en base —
 * jamais sur une valeur venue du client. Un identifiant valide mais appartenant à une autre
 * équipe est refusé aussi sûrement qu'un identifiant inventé.
 */
export async function resolveHomePick(
  db: Db,
  teamId: string,
  pick: HomePick,
): Promise<PickResult> {
  const want = wanted(pick);
  if (!want.ok) return want;

  if (want.kind === "member") {
    const u = await db.user.findUnique({
      where: { id: want.id },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        teamId: true,
        disabledAt: true,
        interclubCltOverride: true,
        squashnetRanking: { select: { clt: true } },
      },
    });
    return decideMember(u, teamId);
  }

  if (want.kind === "guest") {
    const g = await db.interclubGuest.findUnique({
      where: { id: want.id },
      select: { id: true, name: true, teamId: true, clt: true },
    });
    return decideGuest(g, teamId);
  }

  return unsetPick();
}

/**
 * Même résolution, pour PLUSIEURS choix d'un coup — la composition entière d'une rencontre.
 *
 * Deux requêtes au total (`id in […]`), là où appeler `resolveHomePick` dans une boucle en
 * coûtait une PAR LIGNE, sérialisées : jusqu'à huit allers-retours Neon pour une rencontre
 * complètement composée, sur un chemin où le cold start se voit à l'œil nu.
 *
 * ⚠️ Les décisions passent par les MÊMES fonctions (`decideMember`, `decideGuest`) que la
 * version unitaire : c'est ce qui interdit aux deux chemins de diverger sur la règle du club.
 * Le résultat est rendu dans l'ORDRE des choix reçus, refus compris — l'appelant doit pouvoir
 * dire quelle ligne du formulaire est en cause.
 */
export async function resolveHomePicks(
  db: Db,
  teamId: string,
  picks: readonly HomePick[],
): Promise<PickResult[]> {
  const wants = picks.map(wanted);
  const userIds = [...new Set(wants.flatMap((w) => (w.ok && w.kind === "member" ? [w.id] : [])))];
  const guestIds = [...new Set(wants.flatMap((w) => (w.ok && w.kind === "guest" ? [w.id] : [])))];

  const [users, guests] = await Promise.all([
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            displayName: true,
            nickname: true,
            teamId: true,
            disabledAt: true,
            interclubCltOverride: true,
            squashnetRanking: { select: { clt: true } },
          },
        })
      : Promise.resolve([]),
    guestIds.length
      ? db.interclubGuest.findMany({
          where: { id: { in: guestIds } },
          select: { id: true, name: true, teamId: true, clt: true },
        })
      : Promise.resolve([]),
  ]);
  const byUser = new Map(users.map((u) => [u.id, u]));
  const byGuest = new Map(guests.map((g) => [g.id, g]));

  return wants.map((w) => {
    if (!w.ok) return w;
    if (w.kind === "member") return decideMember(byUser.get(w.id) ?? null, teamId);
    if (w.kind === "guest") return decideGuest(byGuest.get(w.id) ?? null, teamId);
    return unsetPick();
  });
}

/** Ce que le corps de la requête DEMANDE, avant toute lecture en base. */
type Wanted =
  | { ok: true; kind: "member"; id: string }
  | { ok: true; kind: "guest"; id: string }
  | { ok: true; kind: "unset" }
  | { ok: false; error: string };

function wanted(pick: HomePick): Wanted {
  const { userId, guestId } = pick;
  const wantsMember = typeof userId === "string" && userId.length > 0;
  const wantsGuest = typeof guestId === "string" && guestId.length > 0;
  if (wantsMember && wantsGuest) {
    return { ok: false, error: "Choisis un membre OU un joueur hors appli, pas les deux" };
  }
  if (wantsMember) return { ok: true, kind: "member", id: userId as string };
  if (wantsGuest) return { ok: true, kind: "guest", id: guestId as string };
  return { ok: true, kind: "unset" };
}

function decideMember(
  u:
    | {
        id: string;
        displayName: string;
        nickname: string | null;
        teamId: string | null;
        disabledAt: Date | null;
        interclubCltOverride: string | null;
        squashnetRanking: { clt: string } | null;
      }
    | null,
  teamId: string,
): PickResult {
  if (!u) return { ok: false, error: "Membre inconnu" };
  if (u.disabledAt) return { ok: false, error: "Ce compte est désactivé" };
  if (u.teamId !== teamId) {
    return { ok: false, error: "Ce membre n'est pas dans l'équipe qui dispute la rencontre" };
  }
  const clt = memberClt(u);
  if (clt == null) {
    return {
      ok: false,
      error: `${memberName(u)} : classement inconnu — attribue-lui un classement avant de le désigner`,
    };
  }
  return {
    ok: true,
    value: {
      homeUserId: u.id,
      homeGuestId: null,
      homeDisplayName: memberName(u),
      clt,
    },
  };
}

function decideGuest(
  g: { id: string; name: string; teamId: string; clt: string | null } | null,
  teamId: string,
): PickResult {
  if (!g) return { ok: false, error: "Joueur inconnu" };
  if (g.teamId !== teamId) {
    return { ok: false, error: "Ce joueur n'est pas dans l'équipe qui dispute la rencontre" };
  }
  if (g.clt == null) {
    return {
      ok: false,
      error: `${g.name} : classement inconnu — attribue-lui un classement avant de le désigner`,
    };
  }
  return {
    ok: true,
    value: {
      homeUserId: null,
      homeGuestId: g.id,
      homeDisplayName: g.name.slice(0, MAX_PLAYER_NAME_LEN),
      clt: g.clt,
    },
  };
}

/**
 * Ni membre ni invité : remise à « à désigner ». Le placeholder est posé PAR LE SERVEUR et
 * n'est jamais repris du corps de la requête — c'était la dernière porte par laquelle un nom
 * libre pouvait entrer, et donc contourner la règle.
 */
function unsetPick(): PickResult {
  return {
    ok: true,
    value: { homeUserId: null, homeGuestId: null, homeDisplayName: UNSET_PLAYER, clt: null },
  };
}

/**
 * L'ORDRE des simples est-il respecté si l'on ajoute `candidate` à la composition actuelle de
 * la rencontre ?
 *
 * Relit les AUTRES simples déjà désignés (leur classement n'est pas stocké sur `InterclubMatch`
 * — seul le nom l'est, figé — donc on le résout à nouveau ici, au moment de la validation) et
 * confronte l'ensemble à `lineupOrderConflict`. Un simple « à désigner » (candidat compris)
 * n'a par construction rien à violer : on inscrit souvent une rencontre avant de savoir qui
 * joue chaque simple.
 *
 * À appeler DANS la transaction qui écrit, comme `findAlignmentClash` : deux capitaines qui
 * composent au même instant doivent voir le même état.
 */
export async function findOrderConflict(
  db: Db & MatchDb,
  fixtureId: string,
  exceptMatchId: string,
  candidate: OrderedSlot,
): Promise<string | null> {
  if (candidate.name === UNSET_PLAYER) return null;

  const siblings = await db.interclubMatch.findMany({
    where: { interclubId: fixtureId, id: { not: exceptMatchId } },
    select: { order: true, homeDisplayName: true, homeUserId: true, homeGuestId: true },
  });
  const designated = siblings.filter((s) => s.homeDisplayName !== UNSET_PLAYER);

  const userIds = [...new Set(designated.flatMap((s) => (s.homeUserId ? [s.homeUserId] : [])))];
  const guestIds = [...new Set(designated.flatMap((s) => (s.homeGuestId ? [s.homeGuestId] : [])))];
  const [users, guests] = await Promise.all([
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, interclubCltOverride: true, squashnetRanking: { select: { clt: true } } },
        })
      : Promise.resolve([]),
    guestIds.length
      ? db.interclubGuest.findMany({ where: { id: { in: guestIds } }, select: { id: true, clt: true } })
      : Promise.resolve([]),
  ]);
  const byUser = new Map(users.map((u) => [u.id, memberClt(u)]));
  const byGuest = new Map(guests.map((g) => [g.id, g.clt]));

  const slots: OrderedSlot[] = designated.map((s) => ({
    order: s.order,
    name: s.homeDisplayName,
    clt: s.homeUserId ? (byUser.get(s.homeUserId) ?? null) : s.homeGuestId ? (byGuest.get(s.homeGuestId) ?? null) : null,
  }));
  slots.push(candidate);

  return lineupOrderConflict(slots);
}
