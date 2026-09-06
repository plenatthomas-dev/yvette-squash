import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody, isUniqueViolation, isMissingRecord } from "@/lib/http-tx";
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

  // La bascule s'appuie sur l'index unique (message, membre, emoji) : deux clics qui se croisent
  // ne peuvent pas créer deux lignes. Mais la base ne tient pas cet invariant EN SILENCE — elle
  // JETTE, et c'était là le défaut : la première version lisait puis écrivait sans rien
  // rattraper. Deux clics à 200 ms d'intervalle, ou deux appareils, et les deux `findUnique`
  // rendaient `null` avant que le premier `create` n'ait été validé ; le second violait
  // l'unicité, la route rendait 500, et l'écran rembobinait son affichage optimiste vers « pas
  // de réaction » ALORS QUE LA BASE EN AVAIT UNE. Le mensonge durait jusqu'au rechargement.
  //
  // P2002 (déjà là) et P2025 (déjà partie) sont donc traités comme des SUCCÈS : dans les deux
  // cas la base est exactement dans l'état que le clic demandait. C'est le cas pour lequel
  // `isUniqueViolation` a été écrit — « deux clics sur Appliquer ne sont pas une faute ».
  const existante = await prisma.forumReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: session.userId, emoji } },
    select: { id: true },
  });
  const on = !existante;
  try {
    if (existante) {
      await prisma.forumReaction.delete({ where: { id: existante.id } });
    } else {
      await prisma.forumReaction.create({ data: { messageId, userId: session.userId, emoji } });
    }
  } catch (e) {
    if (!isUniqueViolation(e) && !isMissingRecord(e)) throw e;
    // Une course perdue ne change pas ce qu'on rend : l'état visé est atteint, et le delta
    // diffusé ci-dessous le décrit toujours correctement — poser une réaction déjà posée, ou
    // retirer une réaction déjà retirée, est idempotent chez tous les clients.
  }

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
