import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_DELEGATION } from "@/lib/features";

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
  // updateMany borné à mon userId de délégant : pas moyen de révoquer la délégation d'un autre.
  await prisma.delegation.updateMany({
    where: { id, delegatorId: session.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
