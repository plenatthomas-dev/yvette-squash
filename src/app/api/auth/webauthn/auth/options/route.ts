import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { getFeatures } from "@/lib/features-server";
import { clientIp } from "@/lib/client-ip";
import {
  rpParams,
  sealChallenge,
  passkeyRateLimited,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_S,
  challengeCookieOptions,
} from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/webauthn/auth/options — prépare une connexion par passkey. On ne passe PAS
// d'allowCredentials : le passkey est découvrable, l'utilisateur n'a donc pas à saisir son
// email — l'appareil propose directement le bon compte.
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  // Anti-abus par IP (aligné sur /auth/verify) : coupe court avant de générer un défi si l'IP
  // martèle les cérémonies passkey.
  if (await passkeyRateLimited(clientIp(req))) {
    return NextResponse.json(
      { error: "Trop de tentatives — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }
  const { rpID } = rpParams(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });

  const res = NextResponse.json(options);
  res.cookies.set(
    CHALLENGE_COOKIE,
    sealChallenge({ challenge: options.challenge, type: "auth" }),
    challengeCookieOptions(CHALLENGE_TTL_S),
  );
  return res;
}
