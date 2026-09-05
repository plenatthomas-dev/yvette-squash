import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import {
  parseForumBody,
  parseForumOption,
  forumPreview,
  MAX_FORUM_LEN,
  MIN_POLL_OPTIONS,
  MAX_POLL_OPTIONS,
} from "@/lib/forum";
import { SELECT_MESSAGE, shapeMessage, shapePoll } from "@/lib/forum-db";
import { pushToUsers } from "@/lib/push";
import { broadcastForum, FORUM_EVENT_MESSAGE } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 30;

/**
 * POST /api/forum/poll { question, options: string[] } -> 201 { message, poll }
 *
 * LE SONDAGE EST UN MESSAGE. La question devient le `body` du message porteur, et le sondage
 * s'y accroche par une relation 1-1. Ce choix évite d'écrire un cycle de vie entier : la
 * suppression, la purge à 12 mois, la notification push et la place chronologique dans le fil
 * sont exactement celles d'un message ordinaire, sans une ligne de plus.
 *
 * Conséquence utile : un client qui ignorerait les sondages afficherait quand même la question
 * comme un message lisible.
 */
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  const question = parseForumBody(raw?.question);
  if (!question) {
    return NextResponse.json(
      { error: `Question invalide (1 à ${MAX_FORUM_LEN} caractères)` },
      { status: 400 },
    );
  }

  const brutes = Array.isArray(raw?.options) ? raw.options : [];
  // On nettoie AVANT de compter : trois champs dont un laissé vide font deux options, pas
  // trois, et l'écran doit refuser à ce moment-là — pas créer un sondage bancal.
  const labels: string[] = [];
  for (const o of brutes) {
    const l = parseForumOption(o);
    // Deux options identiques rendraient le résultat indécidable : « Jeudi » et « Jeudi »
    // séparent les voix de ceux qui voulaient dire la même chose.
    if (l && !labels.includes(l)) labels.push(l);
  }
  if (labels.length < MIN_POLL_OPTIONS || labels.length > MAX_POLL_OPTIONS) {
    return NextResponse.json(
      { error: `Il faut entre ${MIN_POLL_OPTIONS} et ${MAX_POLL_OPTIONS} réponses distinctes.` },
      { status: 400 },
    );
  }

  const recent = await prisma.forumMessage.count({
    where: { authorId: session.userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop de messages d'un coup. Reprends dans quelques minutes." },
      { status: 429 },
    );
  }

  // Message, sondage et options dans UNE transaction : un sondage sans options, ou un message
  // qui promet un vote impossible, serait pire que pas de sondage du tout.
  const { message, poll } = await prisma.$transaction(async (tx) => {
    const message = await tx.forumMessage.create({
      data: { authorId: session.userId, body: question },
      select: SELECT_MESSAGE,
    });
    const poll = await tx.forumPoll.create({
      data: {
        messageId: message.id,
        options: { create: labels.map((label, position) => ({ label, position })) },
      },
      include: {
        options: {
          orderBy: { position: "asc" },
          include: { votes: { include: { user: { select: { displayName: true } } } } },
        },
      },
    });
    return { message, poll };
  });

  const shaped = shapeMessage(message);
  const shapedPoll = shapePoll(poll as never);
  await broadcastForum(FORUM_EVENT_MESSAGE, { ...shaped, poll: shapedPoll });

  const destinataires = await prisma.user.findMany({
    where: { disabledAt: null, forumMuted: false, id: { not: session.userId } },
    select: { id: true },
  });
  await pushToUsers(
    destinataires.map((u) => u.id),
    {
      title: `📊 ${message.author?.displayName ?? "Un membre"}`,
      body: forumPreview(question),
      url: "/?view=forum",
      tag: "forum",
      renotify: true,
    },
  );

  return NextResponse.json({ message: shaped, poll: shapedPoll }, { status: 201 });
}
