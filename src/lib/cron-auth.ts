import type { NextRequest } from "next/server";

/**
 * Autorisation d'un endpoint cron (/api/cron/*). Point unique de vérité, partagé par
 * tous les crons : « Authorization: Bearer $CRON_SECRET » (envoyé automatiquement par
 * Vercel Cron) ou ?token=$CRON_SECRET (déclenchement manuel / cron externe type
 * cron-job.org). Sans secret défini côté serveur → ouvert (pratique en dev).
 */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const token = new URL(req.url).searchParams.get("token");
  return auth === `Bearer ${secret}` || token === secret;
}
