import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_DELEGATION } from "@/lib/features";
import {
  DELEGATION_DURATIONS_H,
  DELEGATION_SCOPE,
  getActiveIncomingDelegation,
  getActiveOutgoingDelegation,
} from "@/lib/delegation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/delegations -> mes délégations actives : celle que je donne (outgoing) et
// celle que je reçois (incoming), s'il y en a une de chaque (v1 : au plus une par sens).
export async function GET(req: NextRequest) {
  if (!FEATURE_DELEGATION) {
    return NextResponse.json({ error: "Délégation désactivée" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const [outgoing, incoming] = await Promise.all([
    getActiveOutgoingDelegation(session.userId),
    getActiveIncomingDelegation(session.userId),
  ]);
  return NextResponse.json({
    outgoing: outgoing
      ? {
          id: outgoing.id,
          delegateId: outgoing.delegateId,
          delegateName: outgoing.delegate.nickname ?? outgoing.delegate.displayName,
          expiresAt: outgoing.expiresAt.toISOString(),
        }
      : null,
    incoming: incoming
      ? {
          id: incoming.id,
          delegatorId: incoming.delegatorId,
          delegatorName: incoming.delegator.nickname ?? incoming.delegator.displayName,
          expiresAt: incoming.expiresAt.toISOString(),
        }
      : null,
  });
}

// POST /api/delegations { delegateId, hours } -> crée une délégation (moi = délégant).
// Remplace silencieusement toute délégation sortante déjà active (v1 : une seule à la fois,
// cf. docs/delegation-droits.md).
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
  const { delegateId, hours } = await req.json().catch(() => ({}));
  if (typeof delegateId !== "string" || !delegateId) {
    return NextResponse.json({ error: "Membre invalide" }, { status: 400 });
  }
  if (delegateId === session.userId) {
    return NextResponse.json(
      { error: "Impossible de se déléguer des droits à soi-même" },
      { status: 400 },
    );
  }
  if (typeof hours !== "number" || !DELEGATION_DURATIONS_H.includes(hours as never)) {
    return NextResponse.json({ error: "Durée invalide" }, { status: 400 });
  }
  const delegate = await prisma.user.findUnique({ where: { id: delegateId } });
  if (!delegate) {
    return NextResponse.json({ error: "Membre introuvable" }, { status: 404 });
  }

  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  const delegation = await prisma.$transaction(async (tx) => {
    // Remplace toute délégation sortante déjà active (une seule à la fois, v1).
    await tx.delegation.updateMany({
      where: { delegatorId: session.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    return tx.delegation.create({
      data: { delegatorId: session.userId, delegateId, scope: DELEGATION_SCOPE, expiresAt },
    });
  });

  return NextResponse.json({
    ok: true,
    id: delegation.id,
    expiresAt: delegation.expiresAt.toISOString(),
  });
}
