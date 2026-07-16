import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { createEmailSession, createResaSessionFromUser } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import {
  rpParams,
  openChallenge,
  CHALLENGE_COOKIE,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours (aligné sur la connexion par mot de passe)

// POST /api/auth/webauthn/auth/verify — vérifie l'assertion du passkey et ouvre une session
// « email seul ». Le passkey découvrable identifie le compte (via son credentialId).
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    response?: AuthenticationResponseJSON;
  };
  if (!body.response?.id) {
    return NextResponse.json({ error: "Réponse d'authentification manquante." }, { status: 400 });
  }

  const chal = openChallenge(req.cookies.get(CHALLENGE_COOKIE)?.value, "auth");
  if (!chal) {
    return NextResponse.json({ error: "Session de connexion expirée — réessaie." }, { status: 400 });
  }

  // Le credentialId renvoyé par l'appareil identifie le compte.
  const passkey = await prisma.passkey.findUnique({
    where: { credentialId: body.response.id },
    include: { user: true },
  });
  if (!passkey) {
    return NextResponse.json({ error: "Passkey inconnu — reconnecte-toi par mot de passe." }, { status: 401 });
  }
  if (passkey.user.disabledAt) {
    return NextResponse.json(
      { error: "Ce compte a été désactivé. Contacte un responsable du club." },
      { status: 403 },
    );
  }

  const { rpID, origin } = rpParams(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: chal.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports
          ? (passkey.transports.split(",") as AuthenticatorTransportFuture[])
          : undefined,
      },
    });
  } catch {
    return NextResponse.json({ error: "Connexion biométrique invalide." }, { status: 401 });
  }
  if (!verification.verified) {
    return NextResponse.json({ error: "Connexion biométrique non vérifiée." }, { status: 401 });
  }

  // Compteur anti-rejeu : on mémorise la nouvelle valeur (0 pour beaucoup de passkeys, c'est ok).
  await prisma.passkey.update({
    where: { id: passkey.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });

  // Ouvre la MEILLEURE session possible pour ce compte :
  //  1) ResaMania restaurée (option A : refresh token réutilisé) → accès complet ;
  //  2) sinon, compte avec connexion email vérifiée → session email-seule (lecture seule) ;
  //  3) sinon → refresh ResaMania mort et pas d'email : reconnexion par mot de passe requise.
  let sid = await createResaSessionFromUser(passkey.userId);
  if (!sid && passkey.user.passwordHash && passkey.user.emailVerifiedAt) {
    sid = await createEmailSession(passkey.userId);
  }
  if (!sid) {
    return NextResponse.json(
      {
        error:
          "Session ResaMania expirée — reconnecte-toi une fois avec ton mot de passe ResaMania, puis la biométrie reprendra.",
      },
      { status: 409 },
    );
  }

  const res = NextResponse.json({ displayName: passkey.user.displayName });
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0)); // efface le défi
  return res;
}
