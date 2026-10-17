import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getResaTokenForUser } from "@/lib/session";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, runCron } from "@/lib/cron-run";
import { pushToUser } from "@/lib/push";
import { isResaRefreshTransient } from "@/lib/resamania/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s : la limite des fonctions Vercel (Fluid compute, plan Hobby compris). 60 s coupait les
// passes longues en plein milieu — toujours les mêmes membres, ceux de fin de liste.
export const maxDuration = 300;

// GET /api/cron/keep-alive-delegations
// Rafraîchit le jeton ResaMania de chaque DÉLÉGANT ayant une délégation active (idée 4),
// indépendamment de l'activité de qui que ce soit — cf. docs/delegation-droits.md,
// « le problème du token qui dort » : sans ce cron, un délégant qui ne rouvre jamais
// l'app pendant la fenêtre déléguée risquerait de voir son jeton devenir irrécupérable
// avant que le délégué n'en ait besoin. Scope volontairement étroit (délégations actives
// seulement, pas tous les membres) pour rester discret sur une API rétro-ingénierée
// (contrainte 1, cf. docs/idees-developpement.md).
async function handle(req: NextRequest) {
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
  // Délégants dont l'état n'a pas pu être établi À CE PASSAGE (ResaMania en panne au moment du
  // rafraîchissement) : ni « ok », ni « KO ». Le passage suivant retentera.
  let reportes = 0;
  for (const { delegatorId } of delegations) {
    // getResaTokenForUser rafraîchit et persiste si besoin, ou renvoie null si le jeton
    // est irrécupérable (session révoquée ailleurs, expirée…). Il LÈVE sur une panne
    // passagère — ce qui, hors de ce try, interrompait toute la boucle : les délégants
    // suivants n'étaient plus rafraîchis du tout, et c'est justement ce rafraîchissement
    // régulier qui empêche leur jeton de devenir irrécupérable.
    let resa;
    try {
      resa = await getResaTokenForUser(delegatorId);
    } catch (e) {
      // SURTOUT PAS la notification « ta délégation ne fonctionne plus » : la session du
      // délégant est intacte, seul ResaMania est injoignable. L'envoyer sur une panne était
      // le faux positif d'avant f44b690 — un membre invité à « se reconnecter » pour rien,
      // chaque fois que ResaMania toussait pendant le passage du cron.
      // Même retenue pour une erreur non passagère (base…) : on ne sait rien de l'état de
      // la délégation, donc on ne dit rien au membre ; on le trace pour nous.
      reportes++;
      if (isResaRefreshTransient(e)) {
        console.warn(
          `[keep-alive-delegations] délégant ${delegatorId} reporté (ResaMania indisponible)`,
        );
      } else {
        console.error(`[keep-alive-delegations] délégant ${delegatorId} sauté:`, e);
      }
      continue;
    }
    if (resa) {
      refreshed++;
      continue;
    }
    failed++;
    // La délégation est inopérante tant que le délégant ne se reconnecte pas : on le
    // prévient (sinon c'est le délégué qui découvre la panne par une erreur au moment
    // d'agir). Relancé à chaque passage quotidien tant que ça dure — fenêtre courte
    // (5 j max) et `tag` stable : la notification se remplace au lieu de s'empiler.
    await pushToUser(delegatorId, {
      title: "Ta délégation ne fonctionne plus ⚠️",
      body:
        "Ta connexion ResaMania n'est plus valide : la personne à qui tu as délégué tes " +
        "droits ne peut plus agir en ton nom. Reconnecte-toi à l'appli pour la réactiver.",
      url: "/",
      tag: `delegation-keepalive-${delegatorId}`,
    }).catch(() => {});
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

  // Rouge si AUCUN délégant n'a pu être traité (ResaMania en panne pendant tout le passage) :
  // le prochain passage est dans 24 h, et c'est justement le moment où un jeton peut mourir.
  await recordCronRun(
    "keep-alive-delegations",
    !(delegations.length > 0 && reportes === delegations.length),
    `${refreshed} ok, ${failed} KO, ${reportes} reporté(s), ${ended} finie(s)`,
  );
  return NextResponse.json({ delegators: delegations.length, refreshed, failed, reportes, ended });
}

// Filet commun (cf. lib/cron-run) : une exception laisse une trace `ok: false` au lieu du
// « ok » de la veille.
export const GET = (req: NextRequest) => runCron("keep-alive-delegations", () => handle(req));
