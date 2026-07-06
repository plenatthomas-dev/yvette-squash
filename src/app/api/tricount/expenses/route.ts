import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { splitWithCredits, MAX_AMOUNT_CENTS, MAX_LABEL_LEN, MAX_TITLE_LEN } from "@/lib/tricount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tricount/expenses -> ajoute une dépense au tricount du jour choisi.
// { date: "YYYY-MM-DD", label, amountCents, payerId, participantIds, title? }
// Le tricount de cette date est créé s'il n'existe pas (title optionnel, pris en
// compte uniquement à la création). Toute modification des dépenses remet à zéro
// les validations « OK pour rembourser » du tricount.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { date, title, label, amountCents, payerId, participantIds } = body as {
    date?: unknown;
    title?: unknown;
    label?: unknown;
    amountCents?: unknown;
    payerId?: unknown;
    participantIds?: unknown;
  };

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (cleanLabel.length === 0 || cleanLabel.length > MAX_LABEL_LEN) {
    return NextResponse.json({ error: "Libellé invalide (1 à 80 caractères)" }, { status: 400 });
  }
  const rawTitle = typeof title === "string" ? title.trim() : "";
  if (rawTitle.length > MAX_TITLE_LEN) {
    return NextResponse.json(
      { error: `Titre trop long (${MAX_TITLE_LEN} caractères max)` },
      { status: 400 },
    );
  }
  const cleanTitle = rawTitle || null;
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

  // Payeur + participants doivent être des membres connus (l'IHM liste les mêmes).
  const known = await prisma.user.findMany({
    where: { id: { in: [payerId, ...uniqueIds] } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((u) => u.id));
  if (!knownIds.has(payerId) || uniqueIds.some((p) => !knownIds.has(p))) {
    return NextResponse.json({ error: "Membre inconnu" }, { status: 400 });
  }

  const tricount = await prisma.tricount.upsert({
    where: { date },
    update: {},
    create: { date, title: cleanTitle },
  });
  // Mémoire des arrondis du tricount : qui a déjà « surpayé » d'un centime ?
  // (part attribuée − part exacte, sommée sur les dépenses existantes)
  const existing = await prisma.expense.findMany({
    where: { tricountId: tricount.id, isRefund: false },
    select: { amountCents: true, shares: { select: { userId: true, amountCents: true } } },
  });
  const credit = new Map<string, number>();
  for (const e of existing) {
    const exact = e.amountCents / e.shares.length;
    for (const s of e.shares) {
      credit.set(s.userId, (credit.get(s.userId) ?? 0) + (s.amountCents - exact));
    }
  }
  const parts = splitWithCredits(amountCents, uniqueIds, credit);
  const [expense] = await prisma.$transaction([
    prisma.expense.create({
      data: {
        tricountId: tricount.id,
        payerId,
        creatorId: session.userId,
        label: cleanLabel,
        amountCents,
        spentAt: new Date(`${date}T12:00:00`),
        shares: {
          create: uniqueIds.map((userId, i) => ({ userId, amountCents: parts[i] })),
        },
      },
    }),
    // Les montants ont changé : chaque payeur devra re-valider avant remboursements.
    prisma.tricountApproval.deleteMany({ where: { tricountId: tricount.id } }),
  ]);
  return NextResponse.json({ id: expense.id, tricountId: tricount.id }, { status: 201 });
}
