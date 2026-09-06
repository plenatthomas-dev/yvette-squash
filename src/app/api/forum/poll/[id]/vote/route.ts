import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody, serializableTransaction, httpErrorResponse } from "@/lib/http-tx";
import { relireSondage } from "@/lib/forum-db";
import { broadcastForum, FORUM_EVENT_POLL } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GARDE-FOU DE DÉBIT, comme sur les messages et les réactions — et ici il protège une ressource
// de plus. Chaque vote coûte une lecture, une transaction à deux écritures, la relecture du
// sondage (quatre ordres) ET UN ÉVÉNEMENT PUSHER, dont le quota est JOURNALIER : un client qui
// boucle n'épuise pas seulement Neon, il fait taire le temps réel du fil pour tout le club
// jusqu'au lendemain. Large comme les autres — cocher soixante fois en dix minutes n'arrive pas
// à quelqu'un qui répond à « qui vient jeudi ? ».
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 60;

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
  try {
    return await voter(req, params);
  } catch (e) {
    // La 409 de contention de `serializableTransaction` doit sortir en JSON : sans ce relais
    // elle deviendrait un 500 muet, et l'écran dirait « Vote non enregistré » là où il suffisait
    // de recliquer.
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
}

async function voter(req: NextRequest, params: Promise<{ id: string }>) {
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

  // SÉRIALISABLE, ET REJOUÉE. Le remplacement « j'efface toutes mes cases, je repose celles
  // que je veux » n'est atomique que si les deux ordres voient le même instantané. En isolation
  // par défaut ils ne le voient pas : cocher « Jeudi » puis « Vendredi » 150 ms plus tard, et le
  // `deleteMany` du second prend son instantané avant que le premier ne soit validé — il ne
  // supprime donc pas la ligne que le premier vient d'insérer, que son `createMany` réinsère.
  // Violation d'unicité, 500, transaction annulée EN ENTIER : le vote « Vendredi » était perdu,
  // et l'écran rembobinait. La route se déclarait pourtant « idempotente et rejouable sans
  // dommage » — elle l'est maintenant, parce que `serializableTransaction` rejoue le P2034.
  //
  // `skipDuplicates` en ceinture : il rend l'insertion inoffensive si une ligne identique
  // subsiste malgré tout, sans jamais masquer un conflit réel (la clé est (option, membre) —
  // un doublon EST le même vote).
  // Compté sur les VOIX du membre, servi par `@@index([userId, createdAt])`. C'est un plafond
  // de gestes, pas de voix retenues : un vote qui remplace un vote compte pour un de plus, et
  // c'est bien le geste qu'on veut borner.
  const recent = await prisma.forumPollVote.count({
    where: { userId: session.userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json({ error: "Trop de votes d'un coup." }, { status: 429 });
  }

  const ids = [...connues];
  await serializableTransaction(
    async (tx) => {
      await tx.forumPollVote.deleteMany({
        where: { userId: session.userId, optionId: { in: ids } },
      });
      if (demandes.length > 0) {
        await tx.forumPollVote.createMany({
          data: demandes.map((optionId) => ({ optionId, userId: session.userId })),
          skipDuplicates: true,
        });
      }
    },
    "Vote non enregistré, réessaie",
  );

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
 *
 * Pas de garde-fou de débit ici, contrairement au vote, et c'est un choix : la route n'écrit
 * qu'une colonne d'UNE ligne dont l'appelant est déjà l'auteur ou l'admin, et il n'existe rien
 * de bon marché à compter pour la borner (une clôture ne laisse pas de trace datée). Le nombre
 * d'appelants possibles est le vrai garde-fou. Si un jour cette route diffusait plus, ou si le
 * quota Pusher devenait tendu, la borne à poser serait sur `ForumPoll.closedAt` — pas ici.
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
