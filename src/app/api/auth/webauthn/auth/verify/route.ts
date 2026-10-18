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
  consumeChallenge,
} from "@/lib/webauthn";
import { appBlockForEmail, appBlockedResponse } from "@/lib/app-block";
import { isResaRefreshTransient } from "@/lib/resamania/errors";
import { RESA_UNAVAILABLE_CODE, RESA_UNAVAILABLE_MESSAGE } from "@/lib/resamania/responses";
import { crossSiteRefusal } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours (aligné sur la connexion par mot de passe)

// POST /api/auth/webauthn/auth/verify — vérifie l'assertion du passkey et ouvre une session
// « email seul ». Le passkey découvrable identifie le compte (via son credentialId).
export async function POST(req: NextRequest) {
  // Connexion forcée depuis un autre site (login CSRF) : refusée d'emblée (cf. lib/same-origin).
  const ailleurs = crossSiteRefusal(req);
  if (ailleurs) return ailleurs;
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
  // Appli fermée par un admin : la biométrie est un CHEMIN DE CONNEXION à part entière — sans
  // cette garde, un membre déjà appairé continuerait d'entrer alors que mot de passe et email
  // sont bloqués. Le passkey ayant déjà identifié le compte, on sait si c'est un admin.
  const block = await appBlockForEmail(passkey.user.email);
  if (block) {
    const res = appBlockedResponse(block);
    res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0)); // défi à usage unique
    return res;
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
  // Défi à usage UNIQUE, côté serveur aussi : un cookie + une réponse capturés ne se rejouent
  // pas dans les 5 minutes du défi (cf. `consumeChallenge`).
  if (!(await consumeChallenge(chal))) {
    await recordPasskeyAttempt(ip);
    return fail(401, "Connexion biométrique déjà utilisée — réessaie.");
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
  //
  // PANNE RESAMANIA PASSAGÈRE au moment de restaurer la session : `createResaSessionFromUser`
  // LÈVE (sa session source est intacte, rien n'a été transféré). On la distingue du `null`
  // (lien vraiment expiré) pour ne pas afficher le 409 « ta connexion ResaMania a expiré,
  // reconnecte-toi avec ton mot de passe » à un membre dont le lien est parfaitement valide.
  // → 503 « réessaie dans un instant », SANS repli sur la session email, même quand le compte en
  // a une : décision produit (2026-10-17), si ResaMania ne marche pas, l'appli ne marche pas. Un
  // repli aurait posé un cookie « email seul » de 30 jours et laissé le membre en lecture seule
  // jusqu'à sa prochaine connexion biométrique, sans qu'il comprenne pourquoi. La session
  // ResaMania source reste intacte : réessayer dans un instant suffit. Rien n'est compté comme
  // tentative ratée — la biométrie, elle, a réussi.
  let sid: string | null = null;
  let resaDown = false;
  try {
    sid = await createResaSessionFromUser(passkey.userId);
  } catch (e) {
    if (!isResaRefreshTransient(e)) throw e; // base en panne, etc. : pas une panne ResaMania
    console.warn(`[webauthn] restauration ResaMania reportée (user ${passkey.userId}) :`, e);
    resaDown = true;
  }
  if (!sid && !resaDown && passkey.user.passwordHash && passkey.user.emailVerifiedAt) {
    sid = await createEmailSession(passkey.userId);
  }
  if (resaDown) {
    const res = NextResponse.json(
      { error: RESA_UNAVAILABLE_MESSAGE, code: RESA_UNAVAILABLE_CODE },
      { status: 503, headers: { "Retry-After": "5" } },
    );
    res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0)); // défi à usage unique
    return res;
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
