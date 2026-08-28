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

/** Une entrée choisissable dans le sélecteur de composition. */
export interface RosterEntry {
  kind: "member" | "guest";
  id: string;
  name: string;
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
      select: { id: true, displayName: true, nickname: true },
    }),
    prisma.interclubGuest.findMany({
      where: { teamId },
      select: { id: true, name: true },
    }),
  ]);

  return [
    ...members.map((u) => ({ kind: "member" as const, id: u.id, name: memberName(u) })),
    ...guests.map((g) => ({ kind: "guest" as const, id: g.id, name: g.name })),
  ].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
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
  const { userId, guestId } = pick;
  const wantsMember = typeof userId === "string" && userId.length > 0;
  const wantsGuest = typeof guestId === "string" && guestId.length > 0;

  if (wantsMember && wantsGuest) {
    return { ok: false, error: "Choisis un membre OU un joueur hors appli, pas les deux" };
  }

  if (wantsMember) {
    const u = await db.user.findUnique({
      where: { id: userId as string },
      select: { id: true, displayName: true, nickname: true, teamId: true, disabledAt: true },
    });
    if (!u) return { ok: false, error: "Membre inconnu" };
    if (u.disabledAt) return { ok: false, error: "Ce compte est désactivé" };
    if (u.teamId !== teamId) {
      return { ok: false, error: "Ce membre n'est pas dans l'équipe qui dispute la rencontre" };
    }
    return {
      ok: true,
      value: { homeUserId: u.id, homeGuestId: null, homeDisplayName: memberName(u) },
    };
  }

  if (wantsGuest) {
    const g = await db.interclubGuest.findUnique({
      where: { id: guestId as string },
      select: { id: true, name: true, teamId: true },
    });
    if (!g) return { ok: false, error: "Joueur inconnu" };
    if (g.teamId !== teamId) {
      return { ok: false, error: "Ce joueur n'est pas dans l'équipe qui dispute la rencontre" };
    }
    return {
      ok: true,
      value: {
        homeUserId: null,
        homeGuestId: g.id,
        homeDisplayName: g.name.slice(0, MAX_PLAYER_NAME_LEN),
      },
    };
  }

  // Ni l'un ni l'autre : remise à « à désigner ». Le placeholder est posé PAR LE SERVEUR et
  // n'est jamais repris du corps de la requête — c'était la dernière porte par laquelle un nom
  // libre pouvait entrer, et donc contourner la règle.
  return {
    ok: true,
    value: { homeUserId: null, homeGuestId: null, homeDisplayName: UNSET_PLAYER },
  };
}
