// Colle entre la base et l'API pour le fil de discussion. Comme `interclub-db.ts`, ce module
// connaît Prisma et ne doit JAMAIS être importé depuis un composant client — les types qu'il
// exporte, si.
//
// Il existe parce que trois routes (le fil, les réactions, les sondages) doivent mettre en
// forme les MÊMES objets. Deux mises en forme parallèles finiraient par diverger sur un détail
// — le tri des options, ou la présence d'un votant — et l'écran afficherait alors deux vérités
// selon la requête qui l'a alimenté.

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { forumPreview } from "./forum";

/** Longueur de l'extrait cité, en points de code. Assez pour reconnaître, trop peu pour relire. */
export const EXCERPT_LEN = 90;

/** Un membre nommé, tel qu'il apparaît dans une réaction ou un vote. */
export type Membre = { id: string; name: string };

/** Les réactions d'un message, regroupées par emoji. Le décompte est `users.length`. */
export type ReactionRow = { emoji: string; users: Membre[] };

/** Une option de sondage, avec ceux qui l'ont cochée. */
export type PollOptionRow = { id: string; label: string; voters: Membre[] };

/** Un sondage, tel que l'écran le reçoit. La QUESTION est le `body` du message porteur. */
export type PollRow = {
  id: string;
  /** Le message porteur : c'est par lui que l'écran raccroche un sondage diffusé à sa place. */
  messageId: string;
  closedAt: string | null;
  options: PollOptionRow[];
};

/**
 * Ce que l'écran reçoit pour un message.
 *
 * PAS de `mine` ni de `canDelete` : ces deux-là dépendent de qui regarde, alors qu'une ligne
 * diffusée par le courtier est la même pour tout le monde. Le client les dérive de `meId` et
 * `admin`, servis une seule fois avec la page — c'est ce qui garantit qu'un message reçu en
 * direct se comporte exactement comme le même message après rechargement.
 */
export type MessageRow = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  /**
   * CITATION. Les trois champs vont ENSEMBLE : ou bien tous les trois sont renseignés, ou bien
   * tous les trois sont `null`. Il n'y a pas d'état intermédiaire, parce qu'ils sont dérivés
   * d'une seule et même jointure — la clé étrangère est en `SET NULL`, donc une cible effacée
   * ou purgée fait disparaître la citation entière, en base comme à l'écran.
   *
   * Rien n'est stocké : `replyToAuthor` et `replyToExcerpt` sont RELUS sur la cible à chaque
   * lecture. C'est ce qui fait que le texte d'un membre ne survit nulle part à son effacement.
   */
  replyToId: string | null;
  replyToAuthor: string | null;
  replyToExcerpt: string | null;
};

export const SELECT_MESSAGE = {
  id: true,
  body: true,
  authorId: true,
  createdAt: true,
  replyToId: true,
  author: { select: { displayName: true } },
  // La cible citée, relue par JOINTURE et non recopiée dans la ligne. Le surcoût est une
  // lecture indexée par la clé primaire ; le bénéfice est qu'aucune parole ne se duplique.
  replyTo: { select: { body: true, author: { select: { displayName: true } } } },
} as const;

type RawMessage = {
  id: string;
  body: string;
  authorId: string;
  createdAt: Date;
  replyToId: string | null;
  author: { displayName: string } | null;
  replyTo: { body: string; author: { displayName: string } | null } | null;
};

export function shapeMessage(m: RawMessage): MessageRow {
  return {
    id: m.id,
    body: m.body,
    authorId: m.authorId,
    // L'auteur peut avoir disparu entre la lecture et l'affichage (compte supprimé, Cascade) —
    // la jointure est alors nulle et le message est en train d'être effacé.
    authorName: m.author?.displayName ?? "Membre supprimé",
    createdAt: m.createdAt.toISOString(),
    // `replyToId` est neutralisé si la jointure ne rend rien : la clé et son contenu doivent
    // vivre et mourir ensemble, sinon l'écran affiche une citation vide.
    replyToId: m.replyTo ? m.replyToId : null,
    replyToAuthor: m.replyTo ? (m.replyTo.author?.displayName ?? "Membre supprimé") : null,
    replyToExcerpt: m.replyTo ? forumPreview(m.replyTo.body, EXCERPT_LEN) : null,
  };
}

/**
 * Les réactions de toute une page de messages, en UNE requête.
 *
 * C'est le point qui décide du coût : un `include` par message aurait produit trente requêtes
 * là où un `in` sur les identifiants déjà connus n'en fait qu'une, servie par l'index
 * `ForumReaction_messageId_idx`. Le regroupement se fait en mémoire, sur au plus quelques
 * centaines de lignes.
 */
export async function chargerReactions(
  messageIds: string[],
): Promise<Record<string, ReactionRow[]>> {
  if (messageIds.length === 0) return {};
  const lignes = await prisma.forumReaction.findMany({
    where: { messageId: { in: messageIds } },
    orderBy: { createdAt: "asc" },
    select: {
      messageId: true,
      emoji: true,
      userId: true,
      user: { select: { displayName: true } },
    },
  });
  const out: Record<string, ReactionRow[]> = {};
  for (const l of lignes) {
    const pour = (out[l.messageId] ??= []);
    const membre = { id: l.userId, name: l.user?.displayName ?? "Membre supprimé" };
    const existante = pour.find((r) => r.emoji === l.emoji);
    if (existante) existante.users.push(membre);
    else pour.push({ emoji: l.emoji, users: [membre] });
  }
  return out;
}

/**
 * L'`include` d'un sondage complet — options triées, voix, et le nom de chaque votant.
 *
 * `satisfies Prisma.ForumPollInclude` et non un `as const` nu : c'est ce qui fait qu'en
 * retirer un morceau devient une ERREUR DE COMPILATION plutôt qu'un `undefined` à
 * l'exécution. La forme reste inférée exactement (le `satisfies` ne l'élargit pas), donc le
 * type de retour de Prisma reste précis et les `as unknown as` disparaissent avec.
 */
export const INCLUDE_POLL = {
  options: {
    orderBy: { position: "asc" },
    include: { votes: { include: { user: { select: { displayName: true } } } } },
  },
} satisfies Prisma.ForumPollInclude;

type RawPoll = {
  id: string;
  messageId: string;
  closedAt: Date | null;
  options: {
    id: string;
    label: string;
    votes: { userId: string; user: { displayName: string } | null }[];
  }[];
};

export function shapePoll(p: RawPoll): PollRow {
  return {
    id: p.id,
    messageId: p.messageId,
    closedAt: p.closedAt?.toISOString() ?? null,
    options: p.options.map((o) => ({
      id: o.id,
      label: o.label,
      // Le vote n'est PAS secret : c'est un club, et un sondage dont on ne voit pas qui a
      // répondu ne permet pas de relancer les absents. La note de confidentialité le dit.
      voters: o.votes.map((v) => ({
        id: v.userId,
        name: v.user?.displayName ?? "Membre supprimé",
      })),
    })),
  };
}

/** Les sondages d'une page de messages, en une requête, indexés par `messageId`. */
export async function chargerSondages(messageIds: string[]): Promise<Record<string, PollRow>> {
  if (messageIds.length === 0) return {};
  const polls = await prisma.forumPoll.findMany({
    where: { messageId: { in: messageIds } },
    include: INCLUDE_POLL,
  });
  const out: Record<string, PollRow> = {};
  for (const p of polls) out[p.messageId] = shapePoll(p);
  return out;
}

/** Relit un sondage entier après un vote, pour le diffuser. */
export async function relireSondage(pollId: string): Promise<PollRow | null> {
  const p = await prisma.forumPoll.findUnique({ where: { id: pollId }, include: INCLUDE_POLL });
  return p ? shapePoll(p) : null;
}
