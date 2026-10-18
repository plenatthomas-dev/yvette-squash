import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { sendEmail, emailConfigured } from "@/lib/email";
import {
  OWNER_INBOX,
  OWNER_MAX_PER_DAY,
  ownerMessagesRecently,
  recordOwnerMessage,
} from "@/lib/owner-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Longueur max d'un commentaire : large pour décrire un bug/une idée, mais bornée contre
// l'abus. Doit rester synchronisée avec le maxLength de la zone de texte (page.tsx).
const MAX_LEN = 1000;

// POST /api/feedback  { message }
// Envoie le commentaire du membre connecté par e-mail au proprio (objet « APPLI SQUASH YVETTE »),
// avec le message et l'e-mail de l'auteur (en reply-to pour répondre directement).
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { message } = (await req.json().catch(() => ({}))) as { message?: unknown };
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "Écris un message avant d'envoyer." }, { status: 400 });
  }
  const text = message.trim();
  if (text.length > MAX_LEN) {
    return NextResponse.json(
      { error: `Message trop long (${text.length}/${MAX_LEN} caractères max).` },
      { status: 400 },
    );
  }

  // Rate limiting : nombre d'envois de ce membre sur les 24 h glissantes (cf. lib/owner-inbox).
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

  // reply-to : email ResaMania si session ResaMania, sinon l'email vérifié du compte.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  const userEmail = session.resa?.identity.email?.trim() || dbUser?.email || "";
  const who = session.displayName || "Membre";

  try {
    await sendEmail({
      to: OWNER_INBOX,
      replyTo: userEmail || undefined,
      subject: "APPLI SQUASH YVETTE",
      text: `Commentaire de ${who}${userEmail ? ` (${userEmail})` : ""} :\n\n${text}`,
    });
  } catch (e) {
    // La cause DOIT être tracée : sans ça, un refus SMTP (clé révoquée, quota…) ne laisse
    // qu'un 502 muet dans les logs, impossible à diagnostiquer. Le client, lui, ne reçoit
    // toujours qu'un message générique (même politique que planning/week/login).
    console.error("[feedback] envoi échoué:", e);
    return NextResponse.json({ error: "Échec de l'envoi, réessaie plus tard." }, { status: 502 });
  }

  // Envoi réussi : on journalise pour le compteur (les envois échoués ne comptent pas).
  await recordOwnerMessage(session.userId);

  return NextResponse.json({ ok: true });
}
