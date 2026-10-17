import type { NextRequest } from "next/server";
import { safeEqual } from "./crypto";

/**
 * Autorisation d'un endpoint cron (/api/cron/*). Point unique de vérité, partagé par
 * tous les crons : « Authorization: Bearer $CRON_SECRET » — envoyé automatiquement par
 * Vercel Cron, et posé en en-tête par les crons externes (cron-job.org le sait faire).
 *
 * Plus de `?token=` : un secret en query string se retrouve dans les logs d'accès, les
 * historiques et les referrers, et le job `check-alerts` l'exposait toutes les 4 minutes
 * (audit 2026-10, point 4). Un job externe resté sur l'ancienne URL reçoit désormais 401.
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
  // Comparaison en temps constant : `===` révélerait, par sa durée, combien d'octets sont
  // corrects. Peu exploitable à travers le réseau sur un secret à haute entropie, mais gratuit.
  return auth !== null && safeEqual(auth, `Bearer ${secret}`);
}
