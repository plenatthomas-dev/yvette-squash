import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/session";
import { emailConfigured } from "@/lib/email";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  EMAIL_RE,
  clientIp,
  emailSendRateLimited,
  createEmailToken,
  sendResetEmail,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/forgot  { email }
// Envoie un lien de réinitialisation SI un compte existe. Réponse toujours générique
// (anti-énumération) : on ne révèle jamais si l'email correspond à un compte.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
  }
  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "Envoi d'e-mail non configuré côté serveur." },
      { status: 503 },
    );
  }

  const email = normalizeEmail(body.email);
  const ip = clientIp(req);
  if (await emailSendRateLimited(email, ip)) {
    return NextResponse.json(
      { error: "Trop de demandes — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    try {
      const token = await createEmailToken({ email, purpose: "reset", ip });
      await sendResetEmail(email, req.nextUrl.origin, token);
    } catch (e) {
      // On journalise mais on renvoie quand même une réponse générique (anti-énumération).
      console.error("[email/forgot] envoi échoué:", e);
    }
  }
  return NextResponse.json({ ok: true });
}
