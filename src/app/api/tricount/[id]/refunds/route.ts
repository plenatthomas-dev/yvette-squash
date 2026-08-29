import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { HttpError, httpErrorResponse, serializableTransaction } from "@/lib/http-tx";
import {
  computeBalances,
  payersOf,
  toKeyedExpense,
  userKey,
  guestKey,
  parseKey,
  MAX_AMOUNT_CENTS,
} from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";

// Erreur métier portant le code HTTP à renvoyer : levée dans la transaction pour
// annuler (rollback) puis retraduite en réponse une fois hors transaction.
// POST /api/tricount/{id}/refunds — deux façons de déclarer un remboursement :
//  - { toId, amountCents } : JE (débiteur connecté) ai remboursé toId. Auto-
//    déclaration classique, seul l'intéressé déclare ses propres remboursements.
//  - { fromGuestId, amountCents } : JE (créancier connecté) ai reçu de cet invité
//    hors asso. Un invité n'a ni compte ni connexion : il ne peut pas déclarer
//    lui-même — c'est donc le créancier (à qui l'argent revient) qui confirme,
//    symétrique à l'auto-déclaration mais inversé.
// Règles communes : tous les payeurs du tricount doivent avoir validé ; le débiteur
// (membre ou invité) doit de l'argent (solde négatif) et le créancier connecté en
// attend (solde positif) ; montant plafonné à ce qui reste dû de part et d'autre
// (les soldes convergent vers zéro).
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

  const body = await req.json().catch(() => ({}));
  const { toId, fromGuestId, amountCents } = body as {
    toId?: unknown;
    fromGuestId?: unknown;
    amountCents?: unknown;
  };
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
  }

  // Résout QUI rembourse QUI, indépendamment de la branche : `fromKey`/`toKey` sont
  // les clés unifiées membre/invité utilisées par computeBalances ; `expensePayer`
  // et `recipientUserId` décrivent la ligne Expense à créer (le bénéficiaire d'un
  // remboursement est TOUJOURS un membre réel : un invité n'a jamais de solde
  // positif, il ne peut donc jamais être `toId`).
  let fromKey: string;
  let toKey: string;
  let expensePayer: { payerId: string } | { payerGuestId: string };
  let recipientUserId: string;
  if (typeof fromGuestId === "string" && fromGuestId.length > 0) {
    const guest = await prisma.tricountGuest.findUnique({
      where: { id: fromGuestId },
      select: { tricountId: true },
    });
    if (!guest || guest.tricountId !== id) {
      return NextResponse.json({ error: "Invité introuvable" }, { status: 400 });
    }
    fromKey = guestKey(fromGuestId);
    toKey = userKey(session.userId);
    expensePayer = { payerGuestId: fromGuestId };
    recipientUserId = session.userId;
  } else if (typeof toId === "string" && toId.length > 0 && toId !== session.userId) {
    fromKey = userKey(session.userId);
    toKey = userKey(toId);
    expensePayer = { payerId: session.userId };
    recipientUserId = toId;
  } else {
    return NextResponse.json({ error: "Bénéficiaire invalide" }, { status: 400 });
  }

  // Tout ce qui touche au solde (relecture des dépenses → vérif du plafond →
  // insertion) doit être ATOMIQUE, sinon deux remboursements simultanés lisent le
  // même solde et le dépassent à eux deux. Transaction Serializable + retry sur
  // conflit de sérialisation (Postgres détecte le write-skew et fait échouer l'un
  // des deux, qu'on rejoue sur un solde à jour).
  let refund: { id: string };
  try {
    refund = await serializableTransaction(async (tx) => {
      const tricount = await tx.tricount.findUnique({
        where: { id },
        include: {
          expenses: {
            include: {
              shares: { select: { userId: true, guestId: true, amountCents: true } },
            },
          },
          approvals: { select: { userId: true } },
        },
      });
      if (!tricount) throw new HttpError(404, "Tricount introuvable");

      const keyedExpenses = tricount.expenses.map(toKeyedExpense);
      // Les invités ne sont jamais payeurs d'une vraie dépense : payersOf ne
      // renvoie donc que des clés membre ("u:xxx"), qu'on dépréfixe pour matcher
      // TricountApproval.userId (toujours un id membre brut).
      const payers = payersOf(keyedExpenses).map((k) => parseKey(k).id);
      const approved = new Set(tricount.approvals.map((a) => a.userId));
      if (payers.length === 0 || !payers.every((p) => approved.has(p))) {
        throw new HttpError(409, "Tous les payeurs doivent d'abord valider ce tricount");
      }

      const balances = computeBalances(keyedExpenses);
      const fromBal = balances.get(fromKey) ?? 0;
      const toBal = balances.get(toKey) ?? 0;
      if (fromBal >= 0) throw new HttpError(400, "Ce débiteur ne doit rien sur ce tricount");
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
          ...expensePayer,
          creatorId: session.userId,
          label: "Remboursement",
          amountCents,
          isRefund: true,
          spentAt: new Date(), // horodatage précis, affiché dans la liste
          shares: { create: [{ userId: recipientUserId, amountCents }] },
        },
      });
    }, "Remboursement concurrent, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
  return NextResponse.json({ id: refund.id }, { status: 201 });
}
