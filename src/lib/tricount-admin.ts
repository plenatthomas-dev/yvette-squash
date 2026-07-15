// Modération des tricounts (espace admin, étape 5) : lister et supprimer un groupe de partage
// de frais (remplace le nettoyage manuel en base). Contrairement à la suppression d'un MEMBRE
// (bloquée par des relations `Restrict`), supprimer un Tricount cascade proprement vers ses
// dépenses/parts/approbations/commentaires (toutes en `onDelete: Cascade`).

import { prisma } from "./db";

export type TricountRow = {
  id: string;
  date: string;
  title: string | null;
  expenseCount: number; // dépenses « réelles » (hors remboursements)
  totalCents: number; // somme des dépenses réelles
  participantCount: number; // membres impliqués (payeurs + porteurs de parts)
  createdAt: string;
};

/** Tous les tricounts avec un résumé chiffré, les plus récents d'abord. */
export async function listTricountsAdmin(): Promise<TricountRow[]> {
  const rows = await prisma.tricount.findMany({
    orderBy: { date: "desc" },
    select: {
      id: true,
      date: true,
      title: true,
      createdAt: true,
      expenses: {
        select: {
          amountCents: true,
          isRefund: true,
          payerId: true,
          shares: { select: { userId: true } },
        },
      },
    },
  });
  return rows.map((t) => {
    const real = t.expenses.filter((e) => !e.isRefund);
    const totalCents = real.reduce((sum, e) => sum + e.amountCents, 0);
    const participants = new Set<string>();
    for (const e of t.expenses) {
      participants.add(e.payerId);
      for (const s of e.shares) participants.add(s.userId);
    }
    return {
      id: t.id,
      date: t.date,
      title: t.title,
      expenseCount: real.length,
      totalCents,
      participantCount: participants.size,
      createdAt: t.createdAt.toISOString(),
    };
  });
}

/** Supprime un tricount (cascade vers dépenses/parts/approbations/commentaires). */
export async function deleteTricount(id: string): Promise<void> {
  await prisma.tricount.deleteMany({ where: { id } });
}
