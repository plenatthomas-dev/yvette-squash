import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { computeBalances, payersOf, MAX_AMOUNT_CENTS } from "@/lib/tricount";
import { FEATURE_TRICOUNT } from "@/lib/features";

export const runtime = "nodejs";

// Erreur métier portant le code HTTP à renvoyer : levée dans la transaction pour
// annuler (rollback) puis retraduite en réponse une fois hors transaction.
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// POST /api/tricount/{id}/refunds { toId, amountCents }
// Enregistre « JE (l'utilisateur connecté) ai remboursé amountCents à toId ».
// Seul l'intéressé déclare ses propres remboursements. Règles : tous les payeurs
// du tricount doivent avoir validé ; je dois de l'argent (solde négatif) et toId
// en attend (solde positif) ; montant plafonné à ce qui reste dû de part et
// d'autre (les soldes convergent vers zéro).
export async function POST(
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

  const body = await req.json().catch(() => ({}));
  const { toId, amountCents } = body as {
    toId?: unknown;
    amountCents?: unknown;
  };
  const fromId = session.userId; // le rembourseur est TOUJOURS l'utilisateur connecté
  if (typeof toId !== "string" || fromId === toId) {
    return NextResponse.json({ error: "Bénéficiaire invalide" }, { status: 400 });
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
  }

  // Tout ce qui touche au solde (relecture des dépenses → vérif du plafond →
  // insertion) doit être ATOMIQUE, sinon deux remboursements simultanés lisent le
  // même solde et le dépassent à eux deux. Transaction Serializable + retry sur
  // conflit de sérialisation (Postgres détecte le write-skew et fait échouer l'un
  // des deux, qu'on rejoue sur un solde à jour).
  const runOnce = () =>
    prisma.$transaction(
      async (tx) => {
        const tricount = await tx.tricount.findUnique({
          where: { id },
          include: {
            expenses: {
              include: { shares: { select: { userId: true, amountCents: true } } },
            },
            approvals: { select: { userId: true } },
          },
        });
        if (!tricount) throw new HttpError(404, "Tricount introuvable");

        const payers = payersOf(tricount.expenses);
        const approved = new Set(tricount.approvals.map((a) => a.userId));
        if (payers.length === 0 || !payers.every((p) => approved.has(p))) {
          throw new HttpError(409, "Tous les payeurs doivent d'abord valider ce tricount");
        }

        const balances = computeBalances(tricount.expenses);
        const fromBal = balances.get(fromId) ?? 0;
        const toBal = balances.get(toId) ?? 0;
        if (fromBal >= 0) throw new HttpError(400, "Tu ne dois rien sur ce tricount");
        if (toBal <= 0) {
          throw new HttpError(400, "Ce membre n'a rien à récupérer sur ce tricount");
        }
        const max = Math.min(-fromBal, toBal);
        if (amountCents > max) {
          throw new HttpError(
            400,
            `Montant trop élevé : au plus ${(max / 100).toFixed(2).replace(".", ",")} €`,
          );
        }

        return tx.expense.create({
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  // P2034 = conflit d'écriture / échec de sérialisation → on rejoue quelques fois.
  const isSerializationConflict = (e: unknown) =>
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";

  for (let attempt = 0; ; attempt++) {
    try {
      const refund = await runOnce();
      return NextResponse.json({ id: refund.id }, { status: 201 });
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if (isSerializationConflict(e) && attempt < 3) continue; // relecture + réessai
      if (isSerializationConflict(e)) {
        return NextResponse.json(
          { error: "Remboursement concurrent, réessaie" },
          { status: 409 },
        );
      }
      throw e;
    }
  }
}
