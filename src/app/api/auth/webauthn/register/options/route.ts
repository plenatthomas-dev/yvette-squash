import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import {
  RP_NAME,
  rpParams,
  sealChallenge,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_S,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/webauthn/register/options — prépare l'enrôlement d'un passkey pour le compte
// « email seul » connecté. Renvoie les options WebAuthn et pose le défi (cookie chiffré).
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // Réservé aux comptes « email seul » : un passkey ouvre une session SANS jeton ResaMania,
  // donc l'associer à un compte ResaMania le rétrograderait en lecture seule.
  if (session.resa) {
    return NextResponse.json(
      { error: "La connexion biométrique est réservée aux comptes par email." },
      { status: 403 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      passkeys: { select: { credentialId: true, transports: true } },
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  }

  const { rpID } = rpParams(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email ?? user.displayName,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // Empêche de ré-enrôler un passkey déjà présent sur cet appareil.
    excludeCredentials: user.passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports
        ? (p.transports.split(",") as AuthenticatorTransportFuture[])
        : undefined,
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform", // biométrie intégrée (Face ID / Touch ID / empreinte)
      residentKey: "preferred", // passkey découvrable → connexion sans saisir l'email
      userVerification: "required", // exige la vérification utilisateur (biométrie / PIN)
    },
  });

  const res = NextResponse.json(options);
  res.cookies.set(
    CHALLENGE_COOKIE,
    sealChallenge({ challenge: options.challenge, type: "reg", userId: user.id }),
    challengeCookieOptions(CHALLENGE_TTL_S),
  );
  return res;
}
