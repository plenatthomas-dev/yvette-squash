import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { sendEmail, emailConfigured } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Destinataire des commentaires (le proprio de l'appli). Surchargeable par variable d'env.
const TO = process.env.FEEDBACK_TO_EMAIL ?? "plenat.thomas@gmail.com";

// Longueur max d'un commentaire : large pour décrire un bug/une idée, mais bornée contre
// l'abus. Doit rester synchronisée avec le maxLength de la zone de texte (page.tsx).
const MAX_LEN = 1000;
// Rate limiting : au-delà de MAX_PER_DAY envois en WINDOW_MS pour un même membre, on refuse
// (protège la boîte mail du spam). Le compteur vit en base — les fonctions serverless n'ont
// pas de mémoire partagée — sur le même modèle que le rate limiting du login.
const WINDOW_MS = 24 * 60 * 60_000; // 24 h glissantes
const MAX_PER_DAY = 10;

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

  // Rate limiting : nombre d'envois de ce membre sur les 24 h glissantes.
  const since = new Date(Date.now() - WINDOW_MS);
  // Purge opportuniste des lignes hors fenêtre (tous membres : garde la table minuscule).
  await prisma.feedbackMessage.deleteMany({ where: { createdAt: { lt: since } } });
  const sentRecently = await prisma.feedbackMessage.count({
    where: { userId: session.userId, createdAt: { gte: since } },
  });
  if (sentRecently >= MAX_PER_DAY) {
    return NextResponse.json(
      { error: `Limite atteinte : ${MAX_PER_DAY} messages par 24 h. Réessaie plus tard.` },
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
      to: TO,
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
  await prisma.feedbackMessage.create({ data: { userId: session.userId } }).catch(() => {});

  return NextResponse.json({ ok: true });
}
