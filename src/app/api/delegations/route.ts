import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_DELEGATION } from "@/lib/features";
import { pushToUser } from "@/lib/push";
import {
  DELEGATION_DURATIONS_H,
  DELEGATION_SCOPE,
  getActiveIncomingDelegations,
  getActiveOutgoingDelegations,
} from "@/lib/delegation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/delegations -> mes délégations actives : celles que je donne (outgoing, une par
// délégué, plusieurs simultanées) et celles que je reçois (incoming, plusieurs délégants).
export async function GET(req: NextRequest) {
  if (!FEATURE_DELEGATION) {
    return NextResponse.json({ error: "Délégation désactivée" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const [outgoing, incoming] = await Promise.all([
    getActiveOutgoingDelegations(session.userId),
    getActiveIncomingDelegations(session.userId),
  ]);
  return NextResponse.json({
    // Tableau (éventuellement vide) : une entrée par délégué actif.
    outgoing: outgoing.map((d) => ({
      id: d.id,
      delegateId: d.delegateId,
      delegateName: d.delegate.nickname ?? d.delegate.displayName,
      expiresAt: d.expiresAt.toISOString(),
    })),
    // Tableau (éventuellement vide) : une entrée par délégant actif.
    incoming: incoming.map((d) => ({
      id: d.id,
      delegatorId: d.delegatorId,
      delegatorName: d.delegator.nickname ?? d.delegator.displayName,
      expiresAt: d.expiresAt.toISOString(),
    })),
  });
}

// Garde-fou : bien au-delà d'un usage réel (l'annuaire d'un club), mais borne une
// requête forgée qui créerait des délégations en masse.
const MAX_DELEGATES = 20;

// POST /api/delegations { delegateIds: string[], hours, extend? } -> crée une délégation
// par membre choisi (moi = délégant). Plusieurs délégués simultanés possibles ; si un des
// membres a déjà une délégation active de ma part, elle est renouvelée (révoquée + recréée).
// Échéance : maintenant + hours, SAUF si `extend` est vrai (prolongation) — alors échéance
// ACTUELLE + hours pour un délégué déjà actif (c'est ce que promet le bouton « +24 h »).
// Chaque prolongation reste bornée par les préréglages et exige une action du délégant.
// Rétro-compat : accepte aussi { delegateId } (ancien client mono).
export async function POST(req: NextRequest) {
  if (!FEATURE_DELEGATION) {
    return NextResponse.json({ error: "Délégation désactivée" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (!session.resa) {
    return NextResponse.json(
      { error: "La délégation nécessite une connexion ResaMania." },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    delegateIds?: unknown;
    delegateId?: unknown;
    hours?: unknown;
    extend?: unknown;
  };
  const extend = body.extend === true;
  const rawIds = Array.isArray(body.delegateIds)
    ? body.delegateIds
    : typeof body.delegateId === "string"
      ? [body.delegateId]
      : [];
  if (rawIds.length === 0 || rawIds.some((x) => typeof x !== "string" || !x)) {
    return NextResponse.json({ error: "Membre invalide" }, { status: 400 });
  }
  const delegateIds = [...new Set(rawIds as string[])];
  if (delegateIds.includes(session.userId)) {
    return NextResponse.json(
      { error: "Impossible de se déléguer des droits à soi-même" },
      { status: 400 },
    );
  }
  if (delegateIds.length > MAX_DELEGATES) {
    return NextResponse.json(
      { error: `Trop de membres sélectionnés (max ${MAX_DELEGATES}).` },
      { status: 400 },
    );
  }
  const { hours } = body;
  if (typeof hours !== "number" || !DELEGATION_DURATIONS_H.includes(hours as never)) {
    return NextResponse.json({ error: "Durée invalide" }, { status: 400 });
  }
  const found = await prisma.user.findMany({
    where: { id: { in: delegateIds } },
    select: { id: true },
  });
  if (found.length !== delegateIds.length) {
    return NextResponse.json({ error: "Membre introuvable" }, { status: 404 });
  }

  const now = Date.now();
  const delegations = await prisma.$transaction(async (tx) => {
    // Prolongation : on lit d'abord les délégations actives vers ces délégués pour partir
    // de leur échéance actuelle (et non de maintenant).
    const existing = extend
      ? await tx.delegation.findMany({
          where: {
            delegatorId: session.userId,
            delegateId: { in: delegateIds },
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { delegateId: true, expiresAt: true },
        })
      : [];
    // Renouvellement : révoque toute délégation active vers CES délégués (au plus une par
    // couple), sans toucher celles données à d'autres membres. endNotifiedAt posé pour que
    // le cron d'expiration ne pousse pas un « délégation terminée » trompeur alors qu'une
    // nouvelle la remplace.
    await tx.delegation.updateMany({
      where: {
        delegatorId: session.userId,
        delegateId: { in: delegateIds },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date(), endNotifiedAt: new Date() },
    });
    const created = [];
    for (const delegateId of delegateIds) {
      const prev = existing.find((e) => e.delegateId === delegateId);
      const expiresAt = new Date(
        (extend && prev ? prev.expiresAt.getTime() : now) + hours * 3_600_000,
      );
      created.push(
        await tx.delegation.create({
          data: { delegatorId: session.userId, delegateId, scope: DELEGATION_SCOPE, expiresAt },
        }),
      );
    }
    return created;
  });

  // Notifie chaque délégataire (push web) qu'il vient de recevoir des droits. Best-effort :
  // un échec d'envoi ne doit jamais faire échouer la délégation elle-même.
  const delegator = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { displayName: true, nickname: true },
  });
  const delegatorName = delegator?.nickname ?? delegator?.displayName ?? "Un membre";
  const fmtWhen = (d: Date) =>
    d.toLocaleString("fr-FR", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    });
  await Promise.all(
    delegations.map((d) =>
      pushToUser(d.delegateId, {
        title: extend ? "Délégation prolongée 🤝" : "Tu as reçu une délégation 🤝",
        body: extend
          ? `${delegatorName} a prolongé ta délégation (réserver/annuler en son nom) jusqu'au ${fmtWhen(d.expiresAt)}.`
          : `${delegatorName} t'a délégué ses droits (réserver/annuler en son nom) jusqu'au ${fmtWhen(d.expiresAt)}.`,
        url: "/",
        tag: `delegation-${d.id}`,
      }).catch(() => {}),
    ),
  );

  return NextResponse.json({
    ok: true,
    // Rétro-compat (clients pas encore rechargés) ; l'échéance qui fait foi est celle de
    // chaque entrée de `delegations` (elle varie en cas de prolongation).
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    delegations: delegations.map((d) => ({
      id: d.id,
      delegateId: d.delegateId,
      expiresAt: d.expiresAt.toISOString(),
    })),
  });
}
