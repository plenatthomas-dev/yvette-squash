// Briques de la « gestion des membres » (espace admin, étape 1). Les routes /api/admin/members
// restent minces en s'appuyant sur ces helpers, eux-mêmes testables sans HTTP.

import { prisma } from "./db";

export type MemberRow = {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  mode: "resamania" | "email"; // ResaMania si un contactId est attaché, sinon « email seul »
  hasPassword: boolean; // pilote « lien d'activation » (non) vs « lien de réinitialisation » (oui)
  verified: boolean; // email prouvé (lien cliqué ou connexion ResaMania)
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

/** Tous les comptes, pour la page d'admin. N'expose JAMAIS le hash du mot de passe. */
export async function listMembers(): Promise<MemberRow[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      displayName: true,
      nickname: true,
      email: true,
      contactId: true,
      passwordHash: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      disabledAt: true,
      createdAt: true,
    },
  });
  return users.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    nickname: u.nickname,
    email: u.email,
    mode: u.contactId ? "resamania" : "email",
    hasPassword: !!u.passwordHash,
    verified: !!u.emailVerifiedAt,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    disabledAt: u.disabledAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}

// Relations `Restrict` qui BLOQUENT la suppression d'un membre : supprimer ne doit jamais
// effacer en douce un historique d'argent (dépenses/parts Tricount) ni un tournoi créé. Les
// autres relations sont en Cascade (sessions, résas, présences, alertes…) ou SetNull
// (participations à un tournoi d'un autre) et se règlent toutes seules.
export type DeleteBlockers = {
  expenses: number; // dépenses payées OU saisies par le membre
  shares: number; // parts de dépense portées par le membre
  tournaments: number; // tournois qu'il a créés
};

/** Compte les dépendances bloquantes. `total > 0` ⇒ la suppression est refusée (désactiver plutôt). */
export async function deleteBlockersFor(userId: string): Promise<DeleteBlockers & { total: number }> {
  const [expenses, shares, tournaments] = await Promise.all([
    prisma.expense.count({ where: { OR: [{ payerId: userId }, { creatorId: userId }] } }),
    prisma.expenseShare.count({ where: { userId } }),
    prisma.tournament.count({ where: { createdById: userId } }),
  ]);
  return { expenses, shares, tournaments, total: expenses + shares + tournaments };
}
