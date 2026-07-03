import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { splitEqually, MAX_AMOUNT_CENTS, MAX_LABEL_LEN } from "@/lib/tricount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tricount/expenses -> enregistre une dépense (ou un remboursement).
// { label, amountCents, payerId, participantIds: string[], isRefund?, spentAt? }
// - dépense : répartie à parts égales entre participantIds (payeur inclus ou non).
// - remboursement (isRefund) : exactement UN participant (le bénéficiaire), la part
//   entière est pour lui — le solde du payeur remonte, celui du bénéficiaire descend.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { label, amountCents, payerId, participantIds, isRefund, spentAt } = body as {
    label?: unknown;
    amountCents?: unknown;
    payerId?: unknown;
    participantIds?: unknown;
    isRefund?: unknown;
    spentAt?: unknown;
  };

  const refund = isRefund === true;
  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (!refund && (cleanLabel.length === 0 || cleanLabel.length > MAX_LABEL_LEN)) {
    return NextResponse.json({ error: "Libellé invalide (1 à 80 caractères)" }, { status: 400 });
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
  }
  if (
    !Array.isArray(participantIds) ||
    participantIds.length === 0 ||
    !participantIds.every((p) => typeof p === "string")
  ) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  const uniqueIds = [...new Set(participantIds as string[])];
  if (refund && uniqueIds.length !== 1) {
    return NextResponse.json(
      { error: "Un remboursement vise un seul bénéficiaire" },
      { status: 400 },
    );
  }
  if (typeof payerId !== "string" || payerId.length === 0) {
    return NextResponse.json({ error: "Payeur invalide" }, { status: 400 });
  }
  if (refund && uniqueIds[0] === payerId) {
    return NextResponse.json({ error: "On ne se rembourse pas soi-même" }, { status: 400 });
  }
  // Date optionnelle (défaut : maintenant), bornée pour éviter les valeurs absurdes.
  let spent = new Date();
  if (spentAt !== undefined) {
    const d = new Date(String(spentAt));
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "Date invalide" }, { status: 400 });
    }
    spent = d;
  }

  // Payeur + participants doivent être des membres connus (l'IHM liste les mêmes).
  const known = await prisma.user.findMany({
    where: { id: { in: [payerId, ...uniqueIds] } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((u) => u.id));
  if (!knownIds.has(payerId) || uniqueIds.some((p) => !knownIds.has(p))) {
    return NextResponse.json({ error: "Membre inconnu" }, { status: 400 });
  }

  const parts = splitEqually(amountCents, uniqueIds.length);
  const expense = await prisma.expense.create({
    data: {
      payerId,
      creatorId: session.userId,
      label: refund ? "Remboursement" : cleanLabel,
      amountCents,
      isRefund: refund,
      spentAt: spent,
      shares: {
        create: uniqueIds.map((userId, i) => ({ userId, amountCents: parts[i] })),
      },
    },
  });
  return NextResponse.json({ id: expense.id }, { status: 201 });
}
