import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "@/lib/crypto";
import { createEmailSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import {
  passwordProblem,
  findApprovedToken,
  nameFromEmail,
} from "@/lib/email-auth";
import { HttpError, httpErrorResponse, serializableTransaction } from "@/lib/http-tx";
import { appBlockForEmail, appBlockedResponse } from "@/lib/app-block";

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
  if (!(await getFeatures()).emailLogin) {
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
  // Appli fermée par un admin : on refuse AVANT de toucher à quoi que ce soit. Le jeton n'est
  // donc PAS consommé et le lien reste valable une fois l'appli rouverte (sous réserve de sa
  // propre expiration) — refuser après coup aurait brûlé le lien pour rien.
  const block = await appBlockForEmail(row.email);
  if (block) return appBlockedResponse(block);

  const passwordHash = await hashPassword(body.password as string);
  let sid: string;
  let displayName: string;
  try {
    ({ sid, displayName } = await serializableTransaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: row.email } });
      if (existing?.disabledAt) {
        throw new HttpError(403, "Ce compte est désactivé.");
      }
      // Le lien approuvé est CONSOMMÉ dans la même transaction que le mot de passe et les
      // sessions : deux envois simultanés ne peuvent donc pas le rejouer tous les deux.
      const claimed = await tx.emailToken.deleteMany({
        where: { id: row.id, tokenHash: row.tokenHash, approvedAt: { not: null }, expiresAt: { gt: new Date() } },
      });
      if (claimed.count !== 1 || (!existing && row.purpose !== "signup")) {
        throw new HttpError(400, "Lien invalide ou expiré.");
      }
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { passwordHash, emailVerifiedAt: new Date() } })
        : await tx.user.create({ data: {
            email: row.email, displayName: row.displayName ?? nameFromEmail(row.email),
            passwordHash, emailVerifiedAt: new Date(),
          } });
      await tx.emailToken.deleteMany({ where: { email: row.email } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      return { sid: await createEmailSession(user.id, tx), displayName: user.displayName };
    }));
  } catch (e) {
    const response = httpErrorResponse(e);
    if (response) return response;
    throw e;
  }
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
