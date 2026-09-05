import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { isForumReaction } from "@/lib/forum";
import { broadcastForum, FORUM_EVENT_REACTION } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Un clic est bien plus facile à répéter qu'un message : le garde-fou est plus large en
// nombre, mais il existe pour la même raison — un client qui boucle remplirait Neon.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 120;

/**
 * POST /api/forum/{id}/reaction { emoji } — pose ou retire sa réaction. BASCULE.
 *
 * Pas de DELETE séparé : « je réagis » et « je retire ma réaction » sont le même geste à
 * l'écran (on re-clique la pastille), et deux routes obligeraient le client à savoir dans
 * quel état il est — savoir qu'il peut perdre entre deux diffusions.
 *
 * Aucune notification push : une réaction est un acquiescement, pas une prise de parole.
 * C'est même la raison d'être de la fonction — dix « ok » écrits coûtent dix notifications.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  // LISTE FERMÉE, jamais un motif : la colonne accepterait sinon n'importe quelle chaîne
  // envoyée par un client bricolé, et une rangée de vingt pastilles ne dirait plus rien.
  if (!isForumReaction(raw?.emoji)) {
    return NextResponse.json({ error: "Réaction inconnue" }, { status: 400 });
  }
  const emoji = raw.emoji;

  const { id: messageId } = await params;
  const message = await prisma.forumMessage.findUnique({
    where: { id: messageId },
    select: { id: true },
  });
  if (!message) return NextResponse.json({ error: "Message introuvable" }, { status: 404 });

  const recent = await prisma.forumReaction.count({
    where: { userId: session.userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json({ error: "Trop de réactions d'un coup." }, { status: 429 });
  }

  // La bascule s'appuie sur l'index unique (message, membre, emoji) : deux clics qui se
  // croisent ne peuvent pas créer deux lignes, c'est la base qui tient l'invariant.
  const existante = await prisma.forumReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: session.userId, emoji } },
    select: { id: true },
  });
  if (existante) {
    await prisma.forumReaction.delete({ where: { id: existante.id } });
  } else {
    await prisma.forumReaction.create({ data: { messageId, userId: session.userId, emoji } });
  }
  const on = !existante;

  const moi = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { displayName: true },
  });
  // On diffuse le DELTA et non le décompte : deux clics simultanés sur deux appareils
  // enverraient sinon deux totaux concurrents dont le dernier arrivé écraserait l'autre.
  await broadcastForum(FORUM_EVENT_REACTION, {
    messageId,
    emoji,
    userId: session.userId,
    userName: moi?.displayName ?? "Membre",
    on,
  });

  return NextResponse.json({ on });
}
