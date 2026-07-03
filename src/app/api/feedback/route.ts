import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Destinataire des commentaires (le proprio de l'appli). Surchargeable par variable d'env.
const TO = process.env.FEEDBACK_TO_EMAIL ?? "plenat.thomas@gmail.com";
// Expéditeur : le domaine partagé de Resend fonctionne pour envoyer vers SA PROPRE adresse
// sans configurer de domaine. Pour envoyer vers d'autres adresses, vérifier un domaine.
const FROM = process.env.FEEDBACK_FROM_EMAIL ?? "Squash Yvette <onboarding@resend.dev>";
const MAX = 2000;

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
  const text = message.trim().slice(0, MAX);

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Envoi d'e-mail non configuré (RESEND_API_KEY manquant côté serveur)." },
      { status: 503 },
    );
  }

  const userEmail = session.resa.identity.email?.trim() || "";
  const who = session.displayName || "Membre";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to: [TO],
    replyTo: userEmail || undefined,
    subject: "APPLI SQUASH YVETTE",
    text: `Commentaire de ${who}${userEmail ? ` (${userEmail})` : ""} :\n\n${text}`,
  });
  if (error) {
    return NextResponse.json({ error: "Échec de l'envoi, réessaie plus tard." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
