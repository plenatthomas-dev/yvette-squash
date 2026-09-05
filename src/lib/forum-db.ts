// Colle entre la base et l'API pour le fil de discussion. Comme `interclub-db.ts`, ce module
// connaît Prisma et ne doit JAMAIS être importé depuis un composant client — les types qu'il
// exporte, si.
//
// Il existe parce que trois routes (le fil, les réactions, les sondages) doivent mettre en
// forme les MÊMES objets. Deux mises en forme parallèles finiraient par diverger sur un détail
// — le tri des options, ou la présence d'un votant — et l'écran afficherait alors deux vérités
// selon la requête qui l'a alimenté.

import { prisma } from "./db";

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
  /** Citation : `null` partout si le message ne répond à rien. */
  replyToId: string | null;
  /** `null` alors que `replyToId` ne l'est pas = la cible a été supprimée depuis. */
  replyToAuthor: string | null;
  replyToExcerpt: string | null;
};

export const SELECT_MESSAGE = {
  id: true,
  body: true,
  authorId: true,
  createdAt: true,
  replyToId: true,
  replyToAuthor: true,
  replyToExcerpt: true,
  author: { select: { displayName: true } },
} as const;

type RawMessage = {
  id: string;
  body: string;
  authorId: string;
  createdAt: Date;
  replyToId: string | null;
  replyToAuthor: string | null;
  replyToExcerpt: string | null;
  author: { displayName: string } | null;
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
    replyToId: m.replyToId,
    replyToAuthor: m.replyToAuthor,
    replyToExcerpt: m.replyToExcerpt,
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

export const INCLUDE_POLL = {
  options: {
    orderBy: { position: "asc" },
    include: { votes: { include: { user: { select: { displayName: true } } } } },
  },
} as const;

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
  for (const p of polls as unknown as RawPoll[]) out[p.messageId] = shapePoll(p);
  return out;
}

/** Relit un sondage entier après un vote, pour le diffuser. */
export async function relireSondage(pollId: string): Promise<PollRow | null> {
  const p = await prisma.forumPoll.findUnique({ where: { id: pollId }, include: INCLUDE_POLL });
  return p ? shapePoll(p as unknown as RawPoll) : null;
}
