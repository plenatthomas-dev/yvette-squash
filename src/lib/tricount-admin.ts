// Modération des tricounts (espace admin, étape 5) : lister et supprimer un groupe de partage
// de frais (remplace le nettoyage manuel en base). Contrairement à la suppression d'un MEMBRE
// (bloquée par des relations `Restrict`), supprimer un Tricount cascade proprement vers ses
// dépenses/parts/approbations/commentaires (toutes en `onDelete: Cascade`).

import { prisma } from "./db";
import { userKey, guestKey } from "./tricount";

export type TricountRow = {
  id: string;
  date: string;
  title: string | null;
  expenseCount: number; // dépenses « réelles » (hors remboursements)
  totalCents: number; // somme des dépenses réelles
  participantCount: number; // membres + invités hors asso impliqués (payeurs + porteurs de parts)
  createdAt: string;
};

/**
 * Les tricounts avec un résumé chiffré, les plus récents d'abord.
 *
 * ⚠️ BORNÉE. La lecture n'avait aucune limite, et elle inclut les dépenses AVEC leurs parts :
 * son coût croissait donc sans fin avec l'historique, sur une base dont le palier gratuit se
 * paie en temps de calcul. Trois soirées par semaine font ~150 tricounts par an ; l'écran
 * d'administration sert à retrouver une soirée récente à effacer, pas à parcourir les archives.
 * Le jour où il faudra remonter plus loin, ce sera une pagination, pas une borne plus haute.
 */
const ADMIN_PAGE = 100;

export async function listTricountsAdmin(): Promise<TricountRow[]> {
  const rows = await prisma.tricount.findMany({
    orderBy: { date: "desc" },
    take: ADMIN_PAGE,
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
          payerGuestId: true,
          shares: { select: { userId: true, guestId: true } },
        },
      },
    },
  });
  return rows.map((t) => {
    const real = t.expenses.filter((e) => !e.isRefund);
    const totalCents = real.reduce((sum, e) => sum + e.amountCents, 0);
    // Clés préfixées (u:/g:) : payerId/userId sont désormais nullable (invité hors
    // asso porté par payerGuestId/guestId) — un Set brut planterait/compterait faux.
    const participants = new Set<string>();
    for (const e of t.expenses) {
      participants.add(e.payerId ? userKey(e.payerId) : guestKey(e.payerGuestId as string));
      for (const s of e.shares) {
        participants.add(s.userId ? userKey(s.userId) : guestKey(s.guestId as string));
      }
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
