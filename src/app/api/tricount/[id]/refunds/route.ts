import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { computeBalances, payersOf, MAX_AMOUNT_CENTS } from "@/lib/tricount";

export const runtime = "nodejs";

// POST /api/tricount/{id}/refunds { fromId, toId, amountCents }
// Enregistre « fromId a remboursé amountCents à toId » dans ce tricount.
// Règles : tous les payeurs du tricount doivent avoir validé ; fromId doit devoir
// de l'argent (solde négatif) et toId en attendre (solde positif) ; le montant est
// plafonné à ce qui reste dû de part et d'autre (les soldes convergent vers zéro).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const { fromId, toId, amountCents } = body as {
    fromId?: unknown;
    toId?: unknown;
    amountCents?: unknown;
  };
  if (typeof fromId !== "string" || typeof toId !== "string" || fromId === toId) {
    return NextResponse.json({ error: "Rembourseur/bénéficiaire invalides" }, { status: 400 });
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
  }

  const tricount = await prisma.tricount.findUnique({
    where: { id },
    include: {
      expenses: {
        include: { shares: { select: { userId: true, amountCents: true } } },
      },
      approvals: { select: { userId: true } },
    },
  });
  if (!tricount) {
    return NextResponse.json({ error: "Tricount introuvable" }, { status: 404 });
  }

  const payers = payersOf(tricount.expenses);
  const approved = new Set(tricount.approvals.map((a) => a.userId));
  if (payers.length === 0 || !payers.every((p) => approved.has(p))) {
    return NextResponse.json(
      { error: "Tous les payeurs doivent d'abord valider ce tricount" },
      { status: 409 },
    );
  }

  const balances = computeBalances(tricount.expenses);
  const fromBal = balances.get(fromId) ?? 0;
  const toBal = balances.get(toId) ?? 0;
  if (fromBal >= 0) {
    return NextResponse.json({ error: "Ce membre ne doit rien sur ce tricount" }, { status: 400 });
  }
  if (toBal <= 0) {
    return NextResponse.json(
      { error: "Ce membre n'a rien à récupérer sur ce tricount" },
      { status: 400 },
    );
  }
  const max = Math.min(-fromBal, toBal);
  if (amountCents > max) {
    return NextResponse.json(
      { error: `Montant trop élevé : au plus ${(max / 100).toFixed(2).replace(".", ",")} €` },
      { status: 400 },
    );
  }

  const refund = await prisma.expense.create({
    data: {
      tricountId: id,
      payerId: fromId,
      creatorId: session.userId,
      label: "Remboursement",
      amountCents,
      isRefund: true,
      spentAt: new Date(), // horodatage précis, affiché dans la liste
      shares: { create: [{ userId: toId, amountCents }] },
    },
  });
  return NextResponse.json({ id: refund.id }, { status: 201 });
}
