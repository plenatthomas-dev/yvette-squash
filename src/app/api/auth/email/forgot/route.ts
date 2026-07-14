import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/session";
import { notifyAdminsOfRequest } from "@/lib/admin";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  EMAIL_RE,
  clientIp,
  emailSendRateLimited,
  createEmailToken,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/forgot  { email }
// Dépose une demande de réinitialisation EN ATTENTE si un compte existe (aucun mail envoyé) :
// un admin l'approuve depuis /admin et transmet le lien. Réponse toujours générique
// (anti-énumération) : on ne révèle jamais si l'email correspond à un compte.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
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
    await createEmailToken({ email, purpose: "reset", ip, approved: false });
    await notifyAdminsOfRequest("reset", email);
  }
  return NextResponse.json({ ok: true });
}
