// Compte ResaMania « de service » DÉDIÉ (identifiants en variables d'env RESA_CRON_USER /
// RESA_CRON_PASSWORD) : les crons qui ne font que LIRE le planning se connectent avec lui,
// indépendamment des sessions des membres.
//
// Deux usages :
//  - warm-planning préchauffe le cache du planning ;
//  - check-alerts lit le planning des jours surveillés. Avant (audit 2026-10, point 8), il le
//    lisait avec le jeton du MEMBRE et sautait ceux qui n'en ont pas : la liste d'attente d'un
//    compte « email seul » ne se déclenchait jamais.

import { login } from "./client";
import { isResaAuthRejected, isResaUnavailable } from "./errors";

/**
 * Connexion du compte de service. Ne lève jamais : rend le jeton, ou la raison de l'échec —
 * « ResaMania en panne, ça reviendra » n'appelle pas la même réaction que « mot de passe du
 * compte de service refusé », qui ne se réparera jamais tout seul.
 */
export async function serviceToken(): Promise<{ token: string; expiresAt: number } | { reason: string }> {
  const username = process.env.RESA_CRON_USER;
  const password = process.env.RESA_CRON_PASSWORD;
  if (!username || !password) return { reason: "compte de service ResaMania non configuré" };
  try {
    const resa = await login({ username, password });
    return { token: resa.accessToken, expiresAt: resa.expiresAt };
  } catch (e) {
    if (isResaUnavailable(e)) return { reason: "ResaMania indisponible, reporté au prochain passage" };
    if (isResaAuthRejected(e)) return { reason: "compte de service ResaMania : identifiants refusés" };
    console.error("[resamania/service] connexion du compte de service en échec:", e);
    return { reason: "compte de service ResaMania KO" };
  }
}

// Jeton gardé en mémoire de l'instance tant qu'il est valide : check-alerts passe toutes les
// ~4 minutes, et un login à chaque passage solliciterait ResaMania pour rien.
let memo: { token: string; expiresAt: number } | null = null;

/** Jeton du compte de service (mémorisé jusqu'à une minute de son expiration), ou `null`. */
export async function serviceAccessToken(now: number = Date.now()): Promise<string | null> {
  if (memo && memo.expiresAt - 60_000 > now) return memo.token;
  const r = await serviceToken();
  if (!("token" in r)) return null;
  memo = { token: r.token, expiresAt: r.expiresAt };
  return memo.token;
}

/** Tests uniquement : oublie le jeton mémorisé. */
export function resetServiceTokenMemo(): void {
  memo = null;
}
