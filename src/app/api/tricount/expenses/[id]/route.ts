import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TRICOUNT } from "@/lib/features";

export const runtime = "nodejs";

// DELETE /api/tricount/expenses/{id} -> supprime une dépense (ou un remboursement).
// Autorisé seulement à celui qui l'a saisie ou au payeur. Supprimer une vraie
// dépense remet à zéro les validations du tricount ; supprimer la dernière ligne
// supprime le tricount lui-même (plus de coquille vide dans l'historique).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!FEATURE_TRICOUNT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const expense = await prisma.expense.findUnique({
    where: { id },
    select: { tricountId: true, isRefund: true, creatorId: true, payerId: true },
  });
  if (!expense || (expense.creatorId !== session.userId && expense.payerId !== session.userId)) {
    return NextResponse.json({ error: "Dépense introuvable ou non autorisée" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.expense.delete({ where: { id } });
    if (!expense.isRefund) {
      await tx.tricountApproval.deleteMany({ where: { tricountId: expense.tricountId } });
    }
    const remaining = await tx.expense.count({ where: { tricountId: expense.tricountId } });
    if (remaining === 0) {
      await tx.tricount.delete({ where: { id: expense.tricountId } });
    }
  });
  return NextResponse.json({ ok: true });
}
