import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/session";
import { notifyAdminsOfRequest } from "@/lib/admin";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  EMAIL_RE,
  clientIp,
  passwordProblem,
  emailSendRateLimited,
  createEmailToken,
  nameFromEmail,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/register  { email, password, name? }
// Démarre une inscription « email seul » sur INVITATION : dépose une demande EN ATTENTE (pas
// de ligne User créée, aucun mail envoyé). Un admin l'approuve depuis /admin et transmet le
// lien d'activation à la main. Réponse toujours générique (anti-énumération) : on ne révèle
// jamais si l'email a déjà un compte.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
  }
  const pwProblem = passwordProblem(body.password);
  if (pwProblem) {
    return NextResponse.json({ error: pwProblem }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const ip = clientIp(req);
  if (await emailSendRateLimited(email, ip)) {
    return NextResponse.json(
      { error: "Trop de demandes — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 60)
      : nameFromEmail(email);
  // On hache TOUJOURS (même coût dans les deux branches ci-dessous → pas d'oracle de timing).
  const passwordHash = await hashPassword(body.password as string);

  const existing = await prisma.user.findUnique({ where: { email } });
  // Compte déjà actif → on n'enfile RIEN (ce serait une réinit déguisée ; la personne doit
  // utiliser « mot de passe oublié »). Sinon on dépose une demande d'activation en attente.
  if (!existing?.passwordHash) {
    await createEmailToken({
      email,
      purpose: "signup",
      ip,
      passwordHash,
      displayName: name,
      approved: false,
    });
    await notifyAdminsOfRequest("signup", email);
  }
  return NextResponse.json({ ok: true });
}
