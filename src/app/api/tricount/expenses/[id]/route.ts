import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  splitWithCredits,
  splitByWeights,
  MAX_AMOUNT_CENTS,
  MAX_LABEL_LEN,
  MAX_PARTS,
} from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { blockEmailOnlyExpenseWrite } from "@/lib/tricount-guard";

export const runtime = "nodejs";

// DELETE /api/tricount/expenses/{id} -> supprime une dépense (ou un remboursement).
// Autorisé seulement à celui qui l'a saisie ou au payeur. Supprimer une vraie
// dépense remet à zéro les validations du tricount ; supprimer la dernière ligne
// supprime le tricount lui-même (plus de coquille vide dans l'historique).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).tricount) {
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
  // Le garde « email seul » ne vaut que pour les vraies DÉPENSES. Un remboursement, ces comptes
  // ont le droit de le déclarer (cf. tricount-guard + route refunds) : leur interdire de le
  // supprimer les enfermait dans leur erreur, d'autant que PATCH renvoie « un remboursement ne se
  // modifie pas, supprime-le et refais-le » — une consigne qu'ils ne pouvaient pas suivre.
  // L'ownership est déjà vérifié ci-dessus : on ne peut défaire que SON propre remboursement.
  if (!expense.isRefund) {
    const blocked = blockEmailOnlyExpenseWrite(session);
    if (blocked) return blocked;
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

// PATCH /api/tricount/expenses/{id} -> modifie une VRAIE dépense (jamais un
// remboursement). { label, amountCents, payerId, participantIds, weights? }.
// Même droit que la suppression (celui qui a saisi la ligne ou le payeur). La date
// (donc le tricount) ne change pas ici. Les parts sont recalculées et les
// validations « OK pour rembourser » remises à zéro (les montants ont bougé).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const blocked = blockEmailOnlyExpenseWrite(session);
  if (blocked) return blocked;
  const { id } = await params;

  const existingExpense = await prisma.expense.findUnique({
    where: { id },
    select: { tricountId: true, isRefund: true, creatorId: true, payerId: true },
  });
  if (
    !existingExpense ||
    (existingExpense.creatorId !== session.userId &&
      existingExpense.payerId !== session.userId)
  ) {
    return NextResponse.json({ error: "Dépense introuvable ou non autorisée" }, { status: 404 });
  }
  if (existingExpense.isRefund) {
    return NextResponse.json(
      { error: "Un remboursement ne se modifie pas (supprime-le et refais-le)" },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { label, amountCents, payerId, participantIds, weights } = body as {
    label?: unknown;
    amountCents?: unknown;
    payerId?: unknown;
    participantIds?: unknown;
    weights?: unknown;
  };

  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (cleanLabel.length === 0 || cleanLabel.length > MAX_LABEL_LEN) {
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
  if (typeof payerId !== "string" || payerId.length === 0) {
    return NextResponse.json({ error: "Payeur invalide" }, { status: 400 });
  }

  // Parts optionnelles (mode « par parts ») : identique à la création.
  let weightArr: number[] | null = null;
  if (weights !== undefined && weights !== null) {
    if (typeof weights !== "object" || Array.isArray(weights)) {
      return NextResponse.json({ error: "Parts invalides" }, { status: 400 });
    }
    const w = weights as Record<string, unknown>;
    weightArr = uniqueIds.map((uid) => (typeof w[uid] === "number" ? (w[uid] as number) : NaN));
    if (weightArr.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PARTS)) {
      return NextResponse.json(
        { error: `Parts invalides (entier de 1 à ${MAX_PARTS} par participant)` },
        { status: 400 },
      );
    }
  }

  // Payeur + participants doivent être des membres connus (comme à la création).
  const known = await prisma.user.findMany({
    where: { id: { in: [payerId, ...uniqueIds] } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((u) => u.id));
  if (!knownIds.has(payerId) || uniqueIds.some((p) => !knownIds.has(p))) {
    return NextResponse.json({ error: "Membre inconnu" }, { status: 400 });
  }

  // Mémoire des arrondis : calculée sur les AUTRES vraies dépenses du tricount
  // (on exclut la ligne éditée pour ne pas se compenser avec son ancienne valeur).
  const others = await prisma.expense.findMany({
    where: { tricountId: existingExpense.tricountId, isRefund: false, id: { not: id } },
    select: { amountCents: true, shares: { select: { userId: true, amountCents: true } } },
  });
  const credit = new Map<string, number>();
  for (const e of others) {
    const exact = e.amountCents / e.shares.length;
    for (const s of e.shares) {
      credit.set(s.userId, (credit.get(s.userId) ?? 0) + (s.amountCents - exact));
    }
  }
  const parts = weightArr
    ? splitByWeights(amountCents, uniqueIds, weightArr)
    : splitWithCredits(amountCents, uniqueIds, credit);

  await prisma.$transaction([
    // Remplace intégralement les parts (participants et montants peuvent changer).
    prisma.expenseShare.deleteMany({ where: { expenseId: id } }),
    prisma.expense.update({
      where: { id },
      data: {
        label: cleanLabel,
        amountCents,
        payerId,
        shares: { create: uniqueIds.map((userId, i) => ({ userId, amountCents: parts[i] })) },
      },
    }),
    // Montants modifiés : chaque payeur devra re-valider avant remboursements.
    prisma.tricountApproval.deleteMany({ where: { tricountId: existingExpense.tricountId } }),
  ]);
  return NextResponse.json({ ok: true, tricountId: existingExpense.tricountId });
}
