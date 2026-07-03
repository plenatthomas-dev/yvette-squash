import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// DELETE /api/tricount/expenses/{id} -> supprime une dépense.
// Autorisé seulement à celui qui l'a saisie ou au payeur (mêmes règles que `canDelete`
// renvoyé par GET /api/tricount). Les parts partent en cascade.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const { count } = await prisma.expense.deleteMany({
    where: {
      id,
      OR: [{ creatorId: session.userId }, { payerId: session.userId }],
    },
  });
  if (count === 0) {
    return NextResponse.json({ error: "Dépense introuvable ou non autorisée" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
