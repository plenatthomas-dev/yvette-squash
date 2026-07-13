import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/session";
import { emailConfigured } from "@/lib/email";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  EMAIL_RE,
  clientIp,
  passwordProblem,
  emailSendRateLimited,
  createEmailToken,
  sendVerificationEmail,
  sendAlreadyRegisteredEmail,
  nameFromEmail,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/register  { email, password, name? }
// Démarre une inscription « email seul » : envoie un LIEN d'activation (pas de ligne User
// créée tant qu'il n'est pas cliqué → aucun squat d'identité possible). Réponse toujours
// générique (anti-énumération) : on ne révèle jamais si l'email a déjà un compte.
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

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 60)
      : nameFromEmail(email);
  // On hache TOUJOURS (même coût dans les deux branches ci-dessous → pas d'oracle de timing).
  const passwordHash = await hashPassword(body.password as string);

  const origin = req.nextUrl.origin;
  const existing = await prisma.user.findUnique({ where: { email } });
  try {
    if (existing?.passwordHash) {
      // Compte déjà actif : pas de lien d'activation (ce serait une réinit déguisée) —
      // on invite à se connecter / réinitialiser.
      await sendAlreadyRegisteredEmail(email, origin);
    } else {
      // Email inconnu, ou compte ResaMania/sans mot de passe → lien d'activation.
      const token = await createEmailToken({
        email,
        purpose: "signup",
        ip,
        passwordHash,
        displayName: name,
      });
      await sendVerificationEmail(email, origin, token);
    }
  } catch (e) {
    console.error("[email/register] envoi échoué:", e);
    return NextResponse.json({ error: "Échec de l'envoi, réessaie plus tard." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
