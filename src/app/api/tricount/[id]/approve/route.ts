import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { payersOf, computeBalances } from "@/lib/tricount";
import { pushToUser } from "@/lib/push";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";

/** "2026-07-09" -> "jeudi 9 juillet" (format français). */
function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** 1234 -> "12,34 €". */
function fmtEuros(cents: number): string {
  return (
    (cents / 100).toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " €"
  );
}

// POST /api/tricount/{id}/approve -> le joueur connecté (qui doit être un payeur
// du tricount) donne son « OK pour lancer les remboursements ». Quand tous les
// payeurs ont validé, les remboursements s'ouvrent. À CE MOMENT-LÀ (et seulement à
// la transition), on notifie par push les débiteurs — ceux qui doivent rembourser —
// pour les prévenir qu'ils peuvent régler (l'utilisateur qui valide n'est pas notifié).
export async function POST(
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
  if (!payers.includes(session.userId)) {
    return NextResponse.json(
      { error: "Seuls les payeurs de ce tricount valident" },
      { status: 403 },
    );
  }

  // Transition « remboursements ouverts » : vrai seulement si ce OK est celui qui
  // complète la validation de TOUS les payeurs (avant : au moins un manquait).
  const approvedBefore = new Set(tricount.approvals.map((a) => a.userId));
  const wasReady = payers.every((p) => approvedBefore.has(p));
  const nowReady = payers.every((p) => approvedBefore.has(p) || p === session.userId);

  await prisma.tricountApproval.upsert({
    where: { tricountId_userId: { tricountId: id, userId: session.userId } },
    update: {},
    create: { tricountId: id, userId: session.userId },
  });

  if (!wasReady && nowReady) {
    // Débiteurs = solde négatif ; on prévient chacun (sauf soi) du montant à rendre.
    const balances = computeBalances(tricount.expenses);
    const debtors = [...balances].filter(
      ([userId, cents]) => cents < 0 && userId !== session.userId,
    );
    await Promise.all(
      debtors.map(([userId, cents]) =>
        pushToUser(userId, {
          title: "Remboursements ouverts 💸",
          body: `Tricount du ${prettyDate(tricount.date)} : tu dois ${fmtEuros(-cents)}.`,
          url: "/?view=money",
          tag: `tricount-ready-${id}`,
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true });
}
