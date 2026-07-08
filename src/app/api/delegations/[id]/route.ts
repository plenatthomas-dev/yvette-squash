import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_DELEGATION } from "@/lib/features";
import { pushToUser } from "@/lib/push";

export const runtime = "nodejs";

// DELETE /api/delegations/{id} -> révoque MA délégation sortante (délégant uniquement).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!FEATURE_DELEGATION) {
    return NextResponse.json({ error: "Délégation désactivée" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  // Borné à MON userId de délégant : pas moyen de révoquer la délégation d'un autre. On lit
  // d'abord la délégation (pour connaître le délégataire à prévenir), puis on révoque en
  // marquant endNotifiedAt → le cron d'expiration ne la re-notifiera pas.
  const deleg = await prisma.delegation.findFirst({
    where: { id, delegatorId: session.userId, revokedAt: null },
    select: { id: true, delegateId: true },
  });
  if (deleg) {
    await prisma.delegation.update({
      where: { id: deleg.id },
      data: { revokedAt: new Date(), endNotifiedAt: new Date() },
    });
    // Prévient le délégataire que ses droits sont retirés (best-effort).
    const delegator = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { displayName: true, nickname: true },
    });
    const name = delegator?.nickname ?? delegator?.displayName ?? "Un membre";
    await pushToUser(deleg.delegateId, {
      title: "Délégation terminée",
      body: `${name} a mis fin à la délégation — tu ne peux plus agir en son nom.`,
      url: "/",
      tag: `delegation-end-${deleg.id}`,
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
