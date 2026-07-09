import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { computeBalances, settle, payersOf } from "@/lib/tricount";
import { FEATURE_TRICOUNT } from "@/lib/features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tricount -> l'historique complet : un tricount par jour, chacun avec ses
// dépenses, ses soldes, ses remboursements suggérés et l'état des validations
// (« OK pour rembourser ») de ses payeurs. Ordre d'affichage : les tricounts EN COURS
// d'abord (plus récent en tête), puis les tricounts ÉQUILIBRÉS en bas.
export async function GET(req: NextRequest) {
  if (!FEATURE_TRICOUNT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const [users, tricounts] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, displayName: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tricount.findMany({
      include: {
        expenses: {
          include: { shares: { select: { userId: true, amountCents: true } } },
          orderBy: [{ isRefund: "asc" }, { spentAt: "asc" }],
        },
        approvals: { select: { userId: true } },
        comments: {
          select: { id: true, body: true, userId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { date: "desc" },
    }),
  ]);

  // Tricount : on affiche TOUJOURS le prénom/nom réel (displayName), jamais le pseudo —
  // pour savoir sans ambiguïté qui a payé quoi et à qui rendre l'argent.
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  const name = (id: string) => nameOf.get(id) ?? "?";

  return NextResponse.json({
    me: session.userId,
    // Compte « email seul » (sans ResaMania) : l'IHM masque alors la gestion des
    // dépenses (création/édition/suppression). Lecture, remboursements, messagerie
    // et validation restent possibles. Le serveur reste la source de vérité (403).
    emailOnly: session.resa === null,
    members: users.map((u) => ({ id: u.id, name: name(u.id), fullName: u.displayName })),
    tricounts: tricounts
      .map((t) => {
      const balances = computeBalances(t.expenses);
      const transfers = settle(balances);
      const payers = payersOf(t.expenses);
      const approved = new Set(t.approvals.map((a) => a.userId));
      const ready = payers.length > 0 && payers.every((p) => approved.has(p));
      const settled = ready && transfers.length === 0;
      return {
        id: t.id,
        date: t.date,
        title: t.title,
        totalCents: t.expenses
          .filter((e) => !e.isRefund)
          .reduce((s, e) => s + e.amountCents, 0),
        ready,
        settled,
        payers: payers.map((p) => ({
          id: p,
          name: name(p),
          approved: approved.has(p),
        })),
        expenses: t.expenses.map((e) => {
          const mine = e.creatorId === session.userId || e.payerId === session.userId;
          return {
            id: e.id,
            label: e.label,
            amountCents: e.amountCents,
            isRefund: e.isRefund,
            spentAt: e.spentAt.toISOString(),
            payerId: e.payerId,
            payerName: name(e.payerId),
            participantIds: e.shares.map((s) => s.userId),
            participantNames: e.shares.map((s) => name(s.userId)),
            canDelete: mine,
            // Édition réservée aux vraies dépenses (un remboursement se supprime/refait).
            canEdit: mine && !e.isRefund,
          };
        }),
        balances: [...balances]
          .map(([userId, cents]) => ({ userId, name: name(userId), cents }))
          .sort((a, b) => b.cents - a.cents),
        transfers: transfers.map((tr) => ({
          ...tr,
          fromName: name(tr.fromId),
          toName: name(tr.toId),
        })),
        // Fil de commentaires (idée 5a). On affiche le nom réel (comme le reste du tricount),
        // jamais le pseudo ; chacun ne peut supprimer que ses propres messages.
        comments: t.comments.map((c) => ({
          id: c.id,
          body: c.body,
          userId: c.userId,
          userName: name(c.userId),
          createdAt: c.createdAt.toISOString(),
          canDelete: c.userId === session.userId,
        })),
      };
      })
      // Équilibrés en bas ; à statut égal, le plus récent en premier (date desc).
      .sort(
        (a, b) => Number(a.settled) - Number(b.settled) || (a.date < b.date ? 1 : -1),
      ),
  });
}
