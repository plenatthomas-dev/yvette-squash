import { NextRequest, NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/session";
import { notifyAdminsOfRequest } from "@/lib/admin";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  EMAIL_RE,
  clientIp,
  emailSendRateLimited,
  createEmailToken,
  nameFromEmail,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/email/register  { email, name? }
// Démarre une inscription « email seul » sur INVITATION : dépose une demande EN ATTENTE (pas
// de ligne User créée, aucun mail envoyé). Un admin l'approuve depuis /admin et transmet le
// lien à la main ; c'est en CLIQUANT sur ce lien que la personne choisit son mot de passe (pas
// ici : le lien peut n'arriver que des heures plus tard). Réponse toujours générique
// (anti-énumération) : on ne révèle jamais si l'email a déjà un compte.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  // Anti-bot invisible (Vercel BotID) : bloque le spam automatisé de la file d'attente admin
  // avant tout travail. Sur un accès direct au endpoint (sans page instrumentée), isBot = true.
  if ((await checkBotId()).isBot) {
    return NextResponse.json({ error: "Requête refusée." }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    name?: unknown;
  };
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

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 60)
      : nameFromEmail(email);

  const existing = await prisma.user.findUnique({ where: { email } });
  // Compte déjà actif → on n'enfile RIEN (ce serait une réinit déguisée ; la personne doit
  // utiliser « mot de passe oublié »). Sinon on dépose une demande d'activation en attente.
  if (!existing?.passwordHash) {
    await createEmailToken({
      email,
      purpose: "signup",
      ip,
      displayName: name,
      approved: false,
    });
    await notifyAdminsOfRequest("signup", email);
  }
  return NextResponse.json({ ok: true });
}
