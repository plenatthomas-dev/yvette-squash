// Mémoire des erreurs non rattrapées (audit 2026-10, point 10).
//
// Sans service tiers : une table, écrite au fil de l'eau, lue dans /admin, purgée à 30 jours
// (cf. retention-purge). Best-effort de bout en bout : consigner une erreur ne doit jamais en
// produire une seconde.
//
// PLAFOND horaire global : la route d'envoi côté navigateur est publique (un écran d'erreur
// s'affiche aussi à un visiteur déconnecté), et une boucle de rendu ou un petit malin
// rempliraient sinon la base. Au-delà, on se contente du log.

import { prisma } from "./db";

export const ERROR_REPORT_RETENTION_DAYS = 30;
const MAX_PER_HOUR = 60;
const clip = (s: unknown, n: number) => (typeof s === "string" && s ? s.slice(0, n) : null);

export async function recordError(e: {
  source: "client" | "server";
  message: unknown;
  digest?: unknown;
  path?: unknown;
  userAgent?: unknown;
}): Promise<boolean> {
  const message = clip(e.message, 500) ?? "(sans message)";
  console.error(`[erreur ${e.source}]`, message, e.digest ?? "", e.path ?? "");
  try {
    const recent = await prisma.errorReport.count({
      where: { createdAt: { gt: new Date(Date.now() - 3_600_000) } },
    });
    if (recent >= MAX_PER_HOUR) return false;
    await prisma.errorReport.create({
      data: {
        source: e.source,
        message,
        digest: clip(e.digest, 100),
        path: clip(e.path, 300),
        userAgent: clip(e.userAgent, 300),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Les dernières erreurs, pour /admin. */
export async function recentErrors(take = 15) {
  return prisma.errorReport.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: { createdAt: true, source: true, message: true, digest: true, path: true },
  });
}
