import type { NextRequest } from "next/server";
import { encrypt, decrypt } from "./crypto";

// Config WebAuthn (passkeys). La biométrie ne quitte jamais l'appareil : ces helpers ne
// manipulent que des défis (challenges) et l'identité du « Relying Party » (notre site).

export const RP_NAME = "Squash de l'Yvette";

// rpID = domaine effectif (hostname sans port ni schéma) ; origin = origine complète attendue
// par le navigateur (schéma + host + port). Dérivés de la requête → marche identiquement en
// local (localhost:3000) et en prod/preview (…vercel.app), sans variable d'environnement.
// ⚠️ Un passkey est lié au rpID : changer de domaine (domaine perso) invalide les passkeys.
export function rpParams(req: NextRequest): { rpID: string; origin: string } {
  const url = req.nextUrl;
  return { rpID: url.hostname, origin: url.origin };
}

// --- Défi (challenge) : lié à une cérémonie, stocké côté client dans un cookie httpOnly
//     CHIFFRÉ et de courte durée (pas de table dédiée). On y met le type de cérémonie et,
//     pour l'enrôlement, l'utilisateur connecté, pour empêcher qu'un défi d'un flux serve
//     dans l'autre. ---
export const CHALLENGE_COOKIE = "wa_chal";
export const CHALLENGE_TTL_S = 5 * 60; // 5 min : large pour la cérémonie, court pour le rejeu

type ChallengePayload = {
  challenge: string;
  type: "reg" | "auth";
  userId?: string; // enrôlement : l'utilisateur connecté qui ajoute un passkey
  exp: number; // epoch ms
};

export function sealChallenge(p: Omit<ChallengePayload, "exp">): string {
  const payload: ChallengePayload = { ...p, exp: Date.now() + CHALLENGE_TTL_S * 1000 };
  return encrypt(JSON.stringify(payload));
}

// Ouvre et VALIDE le cookie de défi : bon type de cérémonie et non expiré. Renvoie null si
// invalide/absent/expiré (l'appelant doit alors refuser la cérémonie).
export function openChallenge(
  cookieValue: string | undefined,
  expectedType: ChallengePayload["type"],
): ChallengePayload | null {
  if (!cookieValue) return null;
  try {
    const p = JSON.parse(decrypt(cookieValue)) as ChallengePayload;
    if (p.type !== expectedType) return null;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    if (typeof p.challenge !== "string" || !p.challenge) return null;
    return p;
  } catch {
    return null;
  }
}

// Options du cookie de défi (posé par les routes /options, effacé par les routes /verify).
export function challengeCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
