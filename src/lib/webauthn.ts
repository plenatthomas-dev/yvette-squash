import type { NextRequest } from "next/server";
import { encrypt, decrypt } from "./crypto";
import { prisma } from "./db";

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

// --- Anti-abus des cérémonies passkey ---------------------------------------------------
// La connexion par passkey est usernameless (aucun identifiant saisi) : on ne peut donc
// plafonner que PAR IP, contrairement au login mot de passe qui compte aussi par compte. On
// réutilise la table `LoginAttempt` (fenêtre 15 min) avec un identifiant SENTINELLE réservé,
// pour ne pas mélanger ce compteur avec celui du login mot de passe. Plafond volontairement
// large : une cérémonie légitime déclenche 0 enregistrement (on ne compte que les ÉCHECS),
// mais il borne le martèlement de /auth/verify (lookups DB + crypto) depuis une même source.
// NB : ces lignes portent l'IP, donc elles pèsent aussi (marginalement) sur le plafond par IP
// du login mot de passe — c'est un durcissement voulu (fail-safe), pas une régression.
const PASSKEY_ATTEMPT_MARKER = "__passkey__"; // jamais un email normalisé → aucun faux positif
const PASSKEY_WINDOW_MS = 15 * 60_000;
const PASSKEY_MAX_PER_IP = 20;

/** true si cette IP a dépassé le plafond d'échecs de cérémonie passkey sur la fenêtre. */
export async function passkeyRateLimited(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - PASSKEY_WINDOW_MS);
  // Purge opportuniste des marqueurs sortis de la fenêtre (garde la table minuscule).
  await prisma.loginAttempt.deleteMany({
    where: { identifier: PASSKEY_ATTEMPT_MARKER, createdAt: { lt: since } },
  });
  const n = await prisma.loginAttempt.count({
    where: { ip, identifier: PASSKEY_ATTEMPT_MARKER, createdAt: { gte: since } },
  });
  return n >= PASSKEY_MAX_PER_IP;
}

/** Enregistre un échec de cérémonie passkey pour cette IP (best-effort, jamais bloquant). */
export async function recordPasskeyAttempt(ip: string): Promise<void> {
  await prisma.loginAttempt
    .create({ data: { ip, identifier: PASSKEY_ATTEMPT_MARKER } })
    .catch(() => {});
}

// --- Libellé d'appareil déduit du User-Agent --------------------------------------------
// Best-effort, quand l'utilisateur n'a rien saisi à l'enrôlement : sert juste à distinguer
// les appareils dans la liste des Réglages (ex. « iPhone · Safari »). Jamais critique.
export function deviceLabelFromUA(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  // iOS force tous les navigateurs sur WebKit : Chrome/Firefox y portent les marqueurs
  // CriOS/FxiOS (et « Safari » aussi) → à tester AVANT le cas Safari générique.
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /CriOS\//.test(ua)
        ? "Chrome"
        : /FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\//.test(ua) && !/Chromium/.test(ua)
            ? "Chrome"
            : /Firefox\//.test(ua)
              ? "Firefox"
              : /Safari\//.test(ua)
                ? "Safari"
                : null;
  if (!os && !browser) return null;
  return [os, browser].filter(Boolean).join(" · ");
}
