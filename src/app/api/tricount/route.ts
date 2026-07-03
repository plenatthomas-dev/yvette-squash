import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { computeBalances, settle } from "@/lib/tricount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tricount -> tout l'état du partage de frais en un appel :
// membres (pour le formulaire), dépenses avec leurs parts, soldes et
// suggestion de remboursements. Les noms affichés = pseudonyme sinon prénom+nom.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const [users, expenses] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, displayName: true, nickname: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.expense.findMany({
      include: { shares: { select: { userId: true, amountCents: true } } },
      orderBy: [{ spentAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const nameOf = new Map(
    users.map((u) => [u.id, (u.nickname ?? "").trim() || u.displayName]),
  );

  const balances = computeBalances(expenses);
  const transfers = settle(balances);

  return NextResponse.json({
    me: session.userId,
    members: users.map((u) => ({ id: u.id, name: nameOf.get(u.id) })),
    expenses: expenses.map((e) => ({
      id: e.id,
      label: e.label,
      amountCents: e.amountCents,
      isRefund: e.isRefund,
      spentAt: e.spentAt.toISOString(),
      payerId: e.payerId,
      payerName: nameOf.get(e.payerId) ?? "?",
      participantNames: e.shares.map((s) => nameOf.get(s.userId) ?? "?"),
      canDelete: e.creatorId === session.userId || e.payerId === session.userId,
    })),
    balances: users
      .map((u) => ({
        userId: u.id,
        name: nameOf.get(u.id),
        cents: balances.get(u.id) ?? 0,
      }))
      // Seuls les joueurs concernés par au moins une dépense apparaissent.
      .filter((b) => balances.has(b.userId)),
    transfers: transfers.map((t) => ({
      ...t,
      fromName: nameOf.get(t.fromId) ?? "?",
      toName: nameOf.get(t.toId) ?? "?",
    })),
  });
}
