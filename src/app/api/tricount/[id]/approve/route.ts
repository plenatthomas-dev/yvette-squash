import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { payersOf } from "@/lib/tricount";

export const runtime = "nodejs";

// POST /api/tricount/{id}/approve -> le joueur connecté (qui doit être un payeur
// du tricount) donne son « OK pour lancer les remboursements ». Quand tous les
// payeurs ont validé, les remboursements s'ouvrent.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const tricount = await prisma.tricount.findUnique({
    where: { id },
    include: { expenses: { select: { payerId: true, isRefund: true } } },
  });
  if (!tricount) {
    return NextResponse.json({ error: "Tricount introuvable" }, { status: 404 });
  }
  const payers = payersOf(tricount.expenses.map((e) => ({ ...e, shares: [] })));
  if (!payers.includes(session.userId)) {
    return NextResponse.json(
      { error: "Seuls les payeurs de ce tricount valident" },
      { status: 403 },
    );
  }
  await prisma.tricountApproval.upsert({
    where: { tricountId_userId: { tricountId: id, userId: session.userId } },
    update: {},
    create: { tricountId: id, userId: session.userId },
  });
  return NextResponse.json({ ok: true });
}
