import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import {
  rpParams,
  openChallenge,
  deviceLabelFromUA,
  CHALLENGE_COOKIE,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/webauthn/register/verify — vérifie l'attestation et enregistre le passkey
// (clé publique + compteur) pour le compte « email seul » connecté.
export async function POST(req: NextRequest) {
  // Réponse d'échec : efface TOUJOURS le défi d'enrôlement (usage unique — cf. auth/verify).
  const fail = (status: number, error: string) => {
    const res = NextResponse.json({ error }, { status });
    res.cookies.set(CHALLENGE_COOKIE, "", challengeCookieOptions(0));
    return res;
  };

  if (!(await getFeatures()).emailLogin) {
    return fail(404, "Fonction indisponible");
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return fail(401, "Non authentifié");
  }

  const body = (await req.json().catch(() => ({}))) as {
    response?: RegistrationResponseJSON;
    deviceLabel?: unknown;
  };
  if (!body.response) {
    return fail(400, "Réponse d'attestation manquante.");
  }
  // Libellé saisi par l'utilisateur, sinon déduit du User-Agent (« iPhone · Safari »), sinon
  // null (la liste affichera « Cet appareil »).
  const deviceLabel =
    typeof body.deviceLabel === "string" && body.deviceLabel.trim()
      ? body.deviceLabel.trim().slice(0, 40)
      : deviceLabelFromUA(req.headers.get("user-agent"));

  // Le défi DOIT correspondre à une cérémonie d'enrôlement lancée par CE compte.
  const chal = openChallenge(req.cookies.get(CHALLENGE_COOKIE)?.value, "reg");
  if (!chal || chal.userId !== session.userId) {
    return fail(400, "Session d'enrôlement expirée — réessaie.");
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
    return fail(400, "Enrôlement invalide.");
  }
  if (!verification.verified || !verification.registrationInfo) {
    return fail(400, "Enrôlement non vérifié.");
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
