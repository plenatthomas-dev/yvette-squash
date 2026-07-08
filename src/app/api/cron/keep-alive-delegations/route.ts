import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getResaTokenForUser } from "@/lib/session";
import { cronAuthorized } from "@/lib/cron-auth";
import { pushToUser } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/keep-alive-delegations
// Rafraîchit le jeton ResaMania de chaque DÉLÉGANT ayant une délégation active (idée 4),
// indépendamment de l'activité de qui que ce soit — cf. docs/delegation-droits.md,
// « le problème du token qui dort » : sans ce cron, un délégant qui ne rouvre jamais
// l'app pendant la fenêtre déléguée risquerait de voir son jeton devenir irrécupérable
// avant que le délégué n'en ait besoin. Scope volontairement étroit (délégations actives
// seulement, pas tous les membres) pour rester discret sur une API rétro-ingénierée
// (contrainte 1, cf. docs/idees-developpement.md).
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const delegations = await prisma.delegation.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    select: { delegatorId: true },
    distinct: ["delegatorId"],
  });

  let refreshed = 0;
  let failed = 0;
  for (const { delegatorId } of delegations) {
    // getResaTokenForUser rafraîchit et persiste si besoin, ou renvoie null si le jeton
    // est irrécupérable (session révoquée ailleurs…) — rien de plus à faire ici, le
    // délégué aura un message d'erreur clair à sa prochaine tentative d'action.
    const resa = await getResaTokenForUser(delegatorId);
    if (resa) refreshed++;
    else failed++;
  }

  // Fins naturelles : notifie chaque délégataire dont la délégation a expiré sans avoir
  // encore reçu de push de fin (endNotifiedAt null). Une révocation manuelle a déjà posé
  // endNotifiedAt → jamais notifiée deux fois. Best-effort ; on marque avant/après l'envoi.
  const expired = await prisma.delegation.findMany({
    where: { endNotifiedAt: null, expiresAt: { lt: new Date() } },
    select: {
      id: true,
      delegateId: true,
      delegator: { select: { displayName: true, nickname: true } },
    },
  });
  let ended = 0;
  for (const d of expired) {
    const name = d.delegator.nickname ?? d.delegator.displayName ?? "Un membre";
    await pushToUser(d.delegateId, {
      title: "Délégation terminée",
      body: `La délégation de ${name} est arrivée à échéance — tu ne peux plus agir en son nom.`,
      url: "/",
      tag: `delegation-end-${d.id}`,
    }).catch(() => {});
    await prisma.delegation
      .update({ where: { id: d.id }, data: { endNotifiedAt: new Date() } })
      .catch(() => {});
    ended++;
  }

  return NextResponse.json({ delegators: delegations.length, refreshed, failed, ended });
}
