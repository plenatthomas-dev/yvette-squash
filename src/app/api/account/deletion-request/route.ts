import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { sendEmail, emailConfigured } from "@/lib/email";
import { deleteBlockersFor } from "@/lib/members";
import {
  OWNER_INBOX,
  OWNER_MAX_PER_DAY,
  ownerMessagesRecently,
  recordOwnerMessage,
} from "@/lib/owner-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/account/deletion-request
//
// Le bouton de la page publique /suppression-compte, pour un membre connecté. Google Play exige
// qu'on puisse DEMANDER la suppression de son compte depuis l'appli et depuis le web ; il
// n'exige pas qu'elle soit immédiate (cf. docs/etude-app-android.md §8).
//
// POURQUOI UNE DEMANDE ET PAS UNE SUPPRESSION EN UN CLIC. La suppression n'est pas toujours
// possible : des dépenses partagées ou un tournoi créé la bloquent (`deleteBlockersFor`), parce
// que ces lignes appartiennent aussi à d'autres membres. Les régler demande un humain. La route
// se contente donc d'envoyer la demande au propriétaire, AVEC ce qui la bloque : il sait tout de
// suite si un clic suffit dans Admin › Membres ou s'il faut d'abord en parler au membre.
//
// La demande part dans la même boîte que les commentaires, sous le même quota (lib/owner-inbox),
// avec l'adresse du membre en reply-to : la confirmation se fait en répondant.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  if ((await ownerMessagesRecently(session.userId)) >= OWNER_MAX_PER_DAY) {
    return NextResponse.json(
      { error: `Limite atteinte : ${OWNER_MAX_PER_DAY} messages par 24 h. Réessaie plus tard.` },
      { status: 429 },
    );
  }

  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "Envoi d'e-mail non configuré côté serveur." },
      { status: 503 },
    );
  }

  // reply-to : même règle que les commentaires — l'e-mail ResaMania si session ResaMania,
  // sinon l'e-mail vérifié du compte.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  const userEmail = session.resa?.identity.email?.trim() || dbUser?.email || "";
  const who = session.displayName || "Membre";
  const blockers = await deleteBlockersFor(session.userId);
  const asked = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  const verdict =
    blockers.total > 0
      ? "⚠️ La suppression est BLOQUÉE par son historique : " +
        `${blockers.expenses} dépense(s) avancée(s) ou créée(s), ` +
        `${blockers.shares} part(s) de dépense, ${blockers.tournaments} tournoi(s) créé(s). ` +
        "Ces lignes concernent d'autres membres : les régler avec la personne, et désactiver le compte " +
        "en attendant (Admin › Membres)."
      : "Rien ne bloque : Admin › Membres › Supprimer.";

  try {
    await sendEmail({
      to: OWNER_INBOX,
      replyTo: userEmail || undefined,
      subject: "APPLI SQUASH YVETTE — demande de suppression de compte",
      text:
        `${who}${userEmail ? ` (${userEmail})` : ""} demande la suppression de son compte.\n\n` +
        `Identifiant : ${session.userId}\n` +
        `Demande faite le : ${asked}\n\n` +
        `${verdict}\n\n` +
        "Délai : un mois au plus (RGPD), tel qu'annoncé sur /suppression-compte. " +
        "Confirmer la suppression en répondant à ce message.",
    });
  } catch (e) {
    console.error("[deletion-request] envoi échoué:", e);
    return NextResponse.json({ error: "Échec de l'envoi, réessaie plus tard." }, { status: 502 });
  }

  await recordOwnerMessage(session.userId);
  return NextResponse.json({ ok: true });
}
