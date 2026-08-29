import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { pushConfigured, pushToUser } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/push/test : s'envoie une notification à SOI-MÊME.
//
// Outil de diagnostic, et le seul qui tranche vraiment. Quand une notification n'arrive pas,
// la chaîne compte cinq maillons — clés du serveur, ligne d'abonnement en base, acceptation
// par le service de push du navigateur, service worker, affichage par le système — et un
// envoi collectif ne dit pas lequel a lâché. Ici on vise UN membre, le sien, et la réponse
// distingue « aucun appareil enregistré » de « envoyé mais rien ne s'affiche » : le premier
// cas est un abonnement manquant, le second un réglage SYSTÈME de l'appareil — Windows, macOS
// et Android coupent les notifications par application, indépendamment du navigateur, qui
// continue alors de les créer sans rien afficher ni rien signaler.
//
// Ne peut viser personne d'autre : `session.userId`, jamais un identifiant reçu du client.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return NextResponse.json(
      { error: "Notifications non configurées sur cet environnement." },
      { status: 503 },
    );
  }

  const devices = await prisma.pushSubscription.count({ where: { userId: session.userId } });
  if (devices === 0) {
    return NextResponse.json({ ok: true, devices: 0, sent: 0 });
  }

  const sent = await pushToUser(session.userId, {
    title: "Squash de l'Yvette",
    body: "Notification de test : si tu lis ceci, tout fonctionne.",
    url: "/",
    // Tag propre au test, pour ne remplacer aucune vraie notification. `renotify` parce qu'un
    // second test doit sonner comme le premier — sinon on croirait qu'il a échoué.
    tag: "push-test",
    renotify: true,
  });

  return NextResponse.json({ ok: true, devices, sent });
}
