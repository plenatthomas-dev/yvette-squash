import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { createEmailSession } from "@/lib/session";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import {
  passwordProblem,
  findApprovedToken,
  consumeEmailTokens,
  nameFromEmail,
} from "@/lib/email-auth";
import type { TokenPurpose } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

// POST /api/auth/email/reset  { token, password }
// Cible du formulaire de /reinitialiser, commun à l'ACTIVATION (jeton "signup") et à la
// RÉINITIALISATION (jeton "reset"). Le clic sur le lien prouve la possession de l'email →
// on pose le mot de passe choisi, marque l'email vérifié, et connecte directement.
//  - signup : crée le compte (ou active un compte ResaMania sans mot de passe) ;
//  - reset  : change le mot de passe d'un compte existant.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 400 });
  }
  const pwProblem = passwordProblem(body.password);
  if (pwProblem) {
    return NextResponse.json({ error: pwProblem }, { status: 400 });
  }

  const row = await findApprovedToken(body.token);
  if (!row) {
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 400 });
  }
  const purpose = row.purpose as TokenPurpose;
  const passwordHash = await hashPassword(body.password as string);

  let userId: string;
  let displayName: string;
  const existing = await prisma.user.findUnique({ where: { email: row.email } });
  if (existing) {
    // Compte connu (email ou ResaMania sans mot de passe) → on pose le mot de passe et on
    // marque l'email vérifié, sans toucher au displayName existant.
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, emailVerifiedAt: new Date() },
    });
    userId = existing.id;
    displayName = existing.displayName;
  } else if (purpose === "signup") {
    // Activation d'un email inconnu → création de la ligne User.
    const created = await prisma.user.create({
      data: {
        email: row.email,
        displayName: row.displayName ?? nameFromEmail(row.email),
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    userId = created.id;
    displayName = created.displayName;
  } else {
    // reset dont le compte a disparu entre la demande et la validation : jeton inutile.
    await consumeEmailTokens(row.email, purpose);
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 400 });
  }
  await consumeEmailTokens(row.email, purpose);

  const sid = await createEmailSession(userId);
  const res = NextResponse.json({ displayName });
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
