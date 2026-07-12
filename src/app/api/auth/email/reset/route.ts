import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { createEmailSession } from "@/lib/session";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import { passwordProblem, findEmailToken, consumeEmailTokens } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

// POST /api/auth/email/reset  { token, password }
// Cible du formulaire de la page /reinitialiser. Le clic sur le lien prouve la possession de
// l'email → on pose le nouveau mot de passe, marque l'email vérifié, et connecte directement.
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

  const row = await findEmailToken(body.token, "reset");
  if (!row) {
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { email: row.email } });
  if (!user) {
    // Le compte a disparu entre la demande et la réinitialisation : jeton devenu inutile.
    await consumeEmailTokens(row.email, "reset");
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 400 });
  }

  const passwordHash = await hashPassword(body.password as string);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, emailVerifiedAt: new Date() },
  });
  await consumeEmailTokens(row.email, "reset");

  const sid = await createEmailSession(user.id);
  const res = NextResponse.json({ displayName: user.displayName });
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
