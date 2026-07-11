import type { NextRequest } from "next/server";

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
  return auth === `Bearer ${secret}` || token === secret;
}
