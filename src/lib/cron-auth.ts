import type { NextRequest } from "next/server";
import { safeEqual } from "./crypto";

/**
 * Autorisation d'un endpoint cron (/api/cron/*). Point unique de vérité, partagé par
 * tous les crons : « Authorization: Bearer $CRON_SECRET » (envoyé automatiquement par
 * Vercel Cron) ou ?token=$CRON_SECRET (déclenchement manuel / cron externe type
 * cron-job.org).
 *
 * Sans secret défini côté serveur → ouvert EN DEV UNIQUEMENT (pratique pour déclencher
 * les crons à la main). En PRODUCTION on échoue FERMÉ : un CRON_SECRET manquant rendrait
 * sinon tous les /api/cron/* publiquement déclenchables (login du compte de service
 * ResaMania à chaque appel, scraping squashnet, spam de push…). Mieux vaut un cron muet
 * qu'un cron ouvert à tous.
 */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  const token = new URL(req.url).searchParams.get("token");
  // Comparaison en temps constant : `===` révélerait, par sa durée, combien d'octets sont
  // corrects. Peu exploitable à travers le réseau sur un secret à haute entropie, mais gratuit.
  // ⚠️ `?token=` est accepté pour les crons externes qui ne posent pas d'en-tête : un secret en
  // query string se retrouve dans les logs d'accès et les referrers. Préférer l'en-tête partout
  // où c'est possible.
  if (auth && safeEqual(auth, `Bearer ${secret}`)) return true;
  return token !== null && safeEqual(token, secret);
}
