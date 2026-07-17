import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { createEmailSession, createResaSessionFromUser } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { clientIp } from "@/lib/client-ip";
import {
  rpParams,
  openChallenge,
  passkeyRateLimited,
  recordPasskeyAttempt,
  CHALLENGE_COOKIE,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours (aligné sur la connexion par mot de passe)

// POST /api/auth/webauthn/auth/verify — vérifie l'assertion du passkey et ouvre une session
// « email seul ». Le passkey découvrable identifie le compte (via son credentialId).
export async function POST(req: NextRequest) {
  // Réponse d'échec : efface TOUJOURS le défi. Un défi est à USAGE UNIQUE — le laisser vivre
  // jusqu'à son TTL après une cérémonie ratée permettrait de le rejouer. (Sur les tout premiers
  // échecs, il n'y a pas encore de cookie de défi : l'effacer est alors sans effet, donc sûr.)
  const fail = (status: number, error: string) => {
    const res = NextResponse.json({ error }, { status });
    res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0));
    return res;
  };

  if (!(await getFeatures()).biometry) {
    return fail(404, "Fonction indisponible");
  }

  const ip = clientIp(req);
  // Anti-abus par IP (flux usernameless → pas d'identifiant à viser). Aligne la posture sur
  // la connexion par mot de passe (cf. api/auth/login).
  if (await passkeyRateLimited(ip)) {
    return fail(429, "Trop de tentatives — réessaie dans quelques minutes.");
  }

  const body = (await req.json().catch(() => ({}))) as {
    response?: AuthenticationResponseJSON;
  };
  if (!body.response?.id) {
    return fail(400, "Réponse d'authentification manquante.");
  }

  const chal = openChallenge(req.cookies.get(CHALLENGE_COOKIE)?.value, "auth");
  if (!chal) {
    return fail(400, "Session de connexion expirée — réessaie.");
  }

  // Le credentialId renvoyé par l'appareil identifie le compte.
  const passkey = await prisma.passkey.findUnique({
    where: { credentialId: body.response.id },
    include: { user: true },
  });
  if (!passkey) {
    // credentialId inconnu = quelqu'un présente un identifiant au hasard → compte comme échec.
    await recordPasskeyAttempt(ip);
    return fail(401, "Passkey inconnu — reconnecte-toi par mot de passe.");
  }
  if (passkey.user.disabledAt) {
    return fail(403, "Ce compte a été désactivé. Contacte un responsable du club.");
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
  } catch (e) {
    // La lib lève aussi sur une RÉGRESSION de compteur (signal de clonage possible) : on log
    // côté serveur pour l'observabilité sécurité, sinon l'échec serait indistinguable d'un
    // simple aléa réseau. Le message client reste volontairement générique.
    await recordPasskeyAttempt(ip);
    console.error(`[webauthn] échec de vérification (passkey ${passkey.id}, user ${passkey.userId}):`, e);
    return fail(401, "Connexion biométrique invalide.");
  }
  if (!verification.verified) {
    await recordPasskeyAttempt(ip);
    console.warn(`[webauthn] assertion non vérifiée (passkey ${passkey.id}, user ${passkey.userId})`);
    return fail(401, "Connexion biométrique non vérifiée.");
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
    // Le passkey ÉTAIT valide (la biométrie a réussi) : ce n'est pas un échec biométrique, mais
    // le lien vers ResaMania a expiré et aucun repli email n'existe. On renvoie l'identifiant
    // (email) du compte : la biométrie ayant prouvé la possession de l'appareil, révéler à
    // l'utilisateur SON PROPRE email est sûr — et ça permet au client de pré-remplir le
    // formulaire ResaMania et de mettre le focus sur le mot de passe (« reconnexion en un geste »).
    const res = NextResponse.json(
      {
        error:
          "Biométrie reconnue ✅ mais ta connexion ResaMania a expiré. Reconnecte-toi via " +
          "l'onglet « ResaMania » (identifiant + mot de passe) : ta biométrie se réactivera " +
          "ensuite toute seule.",
        code: "resa_expired",
        username: passkey.user.email ?? undefined,
      },
      { status: 409 },
    );
    res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0)); // défi à usage unique
    return res;
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
