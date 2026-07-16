import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import {
  rpParams,
  openChallenge,
  CHALLENGE_COOKIE,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/webauthn/register/verify — vérifie l'attestation et enregistre le passkey
// (clé publique + compteur) pour le compte « email seul » connecté.
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (session.resa) {
    return NextResponse.json(
      { error: "La connexion biométrique est réservée aux comptes par email." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    response?: RegistrationResponseJSON;
    deviceLabel?: unknown;
  };
  if (!body.response) {
    return NextResponse.json({ error: "Réponse d'attestation manquante." }, { status: 400 });
  }
  const deviceLabel =
    typeof body.deviceLabel === "string" && body.deviceLabel.trim()
      ? body.deviceLabel.trim().slice(0, 40)
      : null;

  // Le défi DOIT correspondre à une cérémonie d'enrôlement lancée par CE compte.
  const chal = openChallenge(req.cookies.get(CHALLENGE_COOKIE)?.value, "reg");
  if (!chal || chal.userId !== session.userId) {
    return NextResponse.json(
      { error: "Session d'enrôlement expirée — réessaie." },
      { status: 400 },
    );
  }

  const { rpID, origin } = rpParams(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: chal.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json({ error: "Enrôlement invalide." }, { status: 400 });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "Enrôlement non vérifié." }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  try {
    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports?.join(",") ?? null,
        deviceLabel,
      },
    });
  } catch {
    // Unicité credentialId : déjà enrôlé. On considère l'opération comme réussie (idempotent).
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0)); // efface le défi
  return res;
}
