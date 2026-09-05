import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { broadcastForum, FORUM_EVENT_DELETED } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/forum/{id} — son propre message, OU n'importe lequel si on est admin.
 *
 * L'ADMIN PEUT SUPPRIMER CELUI D'UN AUTRE, et c'est l'écart assumé avec le fil des frais
 * partagés (`api/tricount/comments/[id]`), où seul l'auteur peut effacer. Un fil de club est
 * public à tous les membres : il lui faut quelqu'un capable de retirer une insulte ou une
 * donnée personnelle publiée par erreur. Un commentaire attaché à une dépense n'a pas ce
 * besoin — il est lu par trois personnes qui étaient au restaurant.
 *
 * On répond 404 et non 403 quand le message n'est pas le sien : distinguer les deux
 * apprendrait à un curieux quels identifiants existent. Même choix que le fil des frais.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const message = await prisma.forumMessage.findUnique({
    where: { id },
    select: { id: true, authorId: true },
  });
  if (!message || (message.authorId !== session.userId && !isAdminEmail(session.email))) {
    return NextResponse.json({ error: "Message introuvable" }, { status: 404 });
  }

  // SUPPRIMER, C'EST AUSSI EFFACER LES CITATIONS DU MESSAGE.
  //
  // Les réponses gardent un instantané de ce à quoi elles répondent (`replyToExcerpt`), pour
  // s'afficher sans jointure et survivre à la purge. Sans ce blanchiment, effacer son message
  // en laisserait le texte lisible, signé de son nom, dans chaque réponse qu'il a reçue — la
  // note de confidentialité promet exactement le contraire.
  //
  // Les DEUX écritures dans une transaction : entre le `delete` et l'`updateMany`, un lecteur
  // ne doit jamais voir un message disparu dont la citation subsiste. `SET NULL` sur la clé
  // étrangère fait le reste — les réponses, elles, ne bougent pas.
  await prisma.$transaction([
    prisma.forumMessage.updateMany({
      where: { replyToId: id },
      data: { replyToAuthor: null, replyToExcerpt: null },
    }),
    prisma.forumMessage.delete({ where: { id } }),
  ]);

  // Le fil se referme chez tout le monde, sans attendre un rafraîchissement : un message
  // supprimé qui reste affiché ailleurs est précisément ce qu'on cherche à éviter en donnant
  // ce pouvoir à l'admin.
  await broadcastForum(FORUM_EVENT_DELETED, { id });

  return NextResponse.json({ ok: true });
}
