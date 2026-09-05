import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { authorizeForumChannel, FORUM_CHANNEL } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/forum/realtime-auth — signe l'entrée d'un membre sur le canal du fil.
 *
 * Pusher impose ce détour pour tout canal `private-`/`presence-` : le navigateur n'a que la
 * clé PUBLIQUE, il demande ici une signature que seul le serveur peut produire. C'est donc le
 * point où l'appartenance au club est vérifiée — sans lui, n'importe qui connaissant la clé
 * publique écouterait la conversation.
 *
 * ⚠️ CE QU'ON MET DANS `user_info` EST VISIBLE DE TOUS LES ABONNÉS. C'est le principe d'un
 * canal de présence : chacun voit la fiche des autres. On n'y met donc que ce que l'annuaire
 * expose déjà — un identifiant et un nom d'affichage. Jamais l'e-mail, jamais le `contactId`.
 * Le test `route.test.ts` verrouille ce point : c'est la seule chose ici qui, mal faite,
 * divulguerait quelque chose.
 *
 * Le corps arrive en `application/x-www-form-urlencoded` : c'est le client Pusher qui le
 * fabrique, pas nous, et il ne fait pas de JSON.
 */
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const socketId = form?.get("socket_id");
  const channel = form?.get("channel_name");
  if (typeof socketId !== "string" || typeof channel !== "string") {
    return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  }
  // Un seul canal existe. Refuser explicitement tout autre nom évite qu'une signature obtenue
  // ici serve ailleurs le jour où un second canal apparaîtra.
  if (channel !== FORUM_CHANNEL) {
    return NextResponse.json({ error: "Canal refusé" }, { status: 403 });
  }

  const auth = authorizeForumChannel(socketId, channel, {
    id: session.userId,
    name: session.displayName,
  });
  // Courtier non configuré : ce n'est pas une erreur, c'est le mode dégradé prévu. L'écran
  // s'en passe et retombe sur le push et le retour au premier plan.
  if (!auth) {
    return NextResponse.json({ error: "Temps réel indisponible" }, { status: 503 });
  }
  return NextResponse.json(auth);
}
