import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createEmailSession } from "@/lib/session";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import { findEmailToken, consumeEmailTokens, nameFromEmail } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

// GET /api/auth/email/verify?token=…
// Cible du lien d'activation reçu par mail. Pose le mot de passe + marque l'email vérifié,
// ouvre une session « email seul » et redirige vers l'accueil (connexion en un clic).
export async function GET(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const row = await findEmailToken(token, "signup");
  if (!row) {
    // Lien invalide/expiré → retour à l'accueil avec un indicateur (affiché par l'écran de login).
    return NextResponse.redirect(new URL("/?erreur=lien_invalide", req.url), 303);
  }

  // On ne passe PAS par resolveUser ici : il écraserait le displayName d'un compte existant.
  // On ne fixe le nom qu'à la CRÉATION ; sinon on ne touche qu'au mot de passe + vérification.
  const existing = await prisma.user.findUnique({ where: { email: row.email } });
  let userId: string;
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: row.passwordHash ?? undefined, emailVerifiedAt: new Date() },
    });
    userId = existing.id;
  } else {
    const created = await prisma.user.create({
      data: {
        email: row.email,
        displayName: row.displayName ?? nameFromEmail(row.email),
        passwordHash: row.passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    userId = created.id;
  }
  await consumeEmailTokens(row.email, "signup");

  const sid = await createEmailSession(userId);
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
