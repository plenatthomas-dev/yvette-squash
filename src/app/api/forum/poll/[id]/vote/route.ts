import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { relireSondage } from "@/lib/forum-db";
import { broadcastForum, FORUM_EVENT_POLL } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/forum/poll/{id}/vote { optionIds: string[] } — vote À CHOIX MULTIPLE.
 *
 * Le corps porte l'ENSEMBLE des cases cochées, et la route REMPLACE tout ce que le membre
 * avait coché. Un différentiel (« ajoute celle-ci, retire celle-là ») obligerait le client à
 * connaître son état exact, qu'il peut avoir perdu entre deux diffusions ou deux appareils ;
 * un remplacement est idempotent et se rejoue sans dommage.
 *
 * Une liste vide est donc un retrait de vote légitime, pas une erreur.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id: pollId } = await params;
  const raw = await readJsonBody(req);
  const demandes = Array.isArray(raw?.optionIds)
    ? [...new Set(raw.optionIds.filter((x): x is string => typeof x === "string"))]
    : null;
  if (!demandes) return NextResponse.json({ error: "Vote invalide" }, { status: 400 });

  const poll = await prisma.forumPoll.findUnique({
    where: { id: pollId },
    select: { id: true, closedAt: true, options: { select: { id: true } } },
  });
  if (!poll) return NextResponse.json({ error: "Sondage introuvable" }, { status: 404 });
  if (poll.closedAt) {
    return NextResponse.json({ error: "Ce sondage est clos." }, { status: 409 });
  }

  // Les options doivent appartenir À CE sondage : sans ce contrôle, un identifiant emprunté à
  // un autre sondage y ajouterait une voix en douce.
  const connues = new Set(poll.options.map((o) => o.id));
  if (demandes.some((o) => !connues.has(o))) {
    return NextResponse.json({ error: "Réponse inconnue" }, { status: 400 });
  }

  const ids = [...connues];
  await prisma.$transaction([
    prisma.forumPollVote.deleteMany({
      where: { userId: session.userId, optionId: { in: ids } },
    }),
    prisma.forumPollVote.createMany({
      data: demandes.map((optionId) => ({ optionId, userId: session.userId })),
    }),
  ]);

  // On diffuse l'ÉTAT COMPLET du sondage et non un delta : un vote à choix multiple remplace
  // l'ensemble des cases d'un membre, ce qui ne s'exprime pas simplement comme un delta. Le
  // volume est dérisoire — six options, trente membres.
  const etat = await relireSondage(pollId);
  if (etat) await broadcastForum(FORUM_EVENT_POLL, etat);

  return NextResponse.json({ poll: etat });
}

/**
 * PATCH /api/forum/poll/{id}/vote { closed: boolean } — clore ou rouvrir le sondage.
 *
 * Réservé à l'auteur du message porteur ou à un admin : mêmes droits que la suppression, parce
 * que clore un sondage est la version douce de l'effacer.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  if (typeof raw?.closed !== "boolean") {
    return NextResponse.json({ error: "Réglage invalide" }, { status: 400 });
  }

  const { id: pollId } = await params;
  const poll = await prisma.forumPoll.findUnique({
    where: { id: pollId },
    select: { id: true, message: { select: { authorId: true } } },
  });
  // 404 confondu avec 403, comme la suppression d'un message : distinguer les deux
  // apprendrait à un curieux quels identifiants existent.
  if (!poll || (poll.message.authorId !== session.userId && !isAdminEmail(session.email))) {
    return NextResponse.json({ error: "Sondage introuvable" }, { status: 404 });
  }

  await prisma.forumPoll.update({
    where: { id: pollId },
    data: { closedAt: raw.closed ? new Date() : null },
  });

  const etat = await relireSondage(pollId);
  if (etat) await broadcastForum(FORUM_EVENT_POLL, etat);

  return NextResponse.json({ poll: etat });
}
