// Briques de la « gestion des membres » (espace admin, étape 1). Les routes /api/admin/members
// restent minces en s'appuyant sur ces helpers, eux-mêmes testables sans HTTP.

import { prisma } from "./db";

// Un passkey enrôlé (un par appareil). Exposé à l'admin pour révoquer appareil par appareil
// (ex. téléphone perdu) sans tout effacer d'un coup.
export type MemberPasskey = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export type MemberRow = {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  mode: "resamania" | "email"; // ResaMania si un contactId est attaché, sinon « email seul »
  hasPassword: boolean; // pilote « lien d'activation » (non) vs « lien de réinitialisation » (oui)
  verified: boolean; // email prouvé (lien cliqué ou connexion ResaMania)
  passkeys: MemberPasskey[]; // passkeys enrôlés → badge « 🔐 N » + révocation (par appareil ou en masse)
  lastLoginAt: string | null; // dernière AUTHENTIFICATION (login ResaMania / email / biométrie)
  lastSeenAt: string | null; // dernière ACTIVITÉ réelle (throttlée), même sans ré-authentification
  disabledAt: string | null;
  createdAt: string;
  // Équipe interclub, décidée par l'admin depuis cette page (NULL = aucune). Ce n'est pas une
  // préférence du membre : elle décide qui peut être aligné dans une rencontre.
  teamId: string | null;
  // Classement fédéral EFFECTIF pour l'ordre des simples interclub (cf. lib/interclub-order.ts) :
  // la correction admin si posée, sinon le dernier rapprochement squashnet. `cltOverride` porte
  // la correction seule (pour préremplir le champ de saisie) ; `cltSource` dit d'où vient
  // `clt` — l'admin doit savoir si ce qu'il voit est le rapprochement automatique ou déjà une
  // correction, avant d'écraser l'un ou l'autre.
  clt: string | null;
  cltOverride: string | null;
  cltSource: "override" | "squashnet" | null;
  // Origine des résas du membre sur 30 j glissants (cf. src/lib/booking-origin.ts pour la
  // mise en mots, qui dépend aussi de `mode` : un compte « email seul » n'est pas mesurable).
  bookingsApp: number;
  bookingsResa: number;
};

/** Fenêtre des compteurs d'origine, alignée sur celle du tableau de bord. */
export const ORIGIN_WINDOW_DAYS = 30;

/** Tous les comptes, pour la page d'admin. N'expose JAMAIS le hash du mot de passe. */
export async function listMembers(): Promise<MemberRow[]> {
  // Origine des résas : UNE agrégation pour tous les membres (et non une requête par membre,
  // qui ferait N allers-retours sur une base Neon souvent froide).
  const since = new Date(Date.now() - ORIGIN_WINDOW_DAYS * 864e5);
  const originRows = await prisma.booking.groupBy({
    by: ["userId", "source"],
    where: { status: "booked", startsAt: { gte: since } },
    _count: { _all: true },
  });
  const originByUser = new Map<string, { app: number; resa: number }>();
  for (const r of originRows) {
    const cur = originByUser.get(r.userId) ?? { app: 0, resa: 0 };
    if (r.source === "resamania") cur.resa += r._count._all;
    else cur.app += r._count._all; // "app" et toute valeur héritée inattendue
    originByUser.set(r.userId, cur);
  }

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
      lastSeenAt: true,
      disabledAt: true,
      createdAt: true,
      teamId: true,
      interclubCltOverride: true,
      squashnetRanking: { select: { clt: true } },
      passkeys: {
        select: { id: true, deviceLabel: true, createdAt: true, lastUsedAt: true },
        orderBy: { createdAt: "desc" },
      },
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
    passkeys: u.passkeys.map((p) => ({
      id: p.id,
      deviceLabel: p.deviceLabel,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    })),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    disabledAt: u.disabledAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    teamId: u.teamId,
    clt: u.interclubCltOverride ?? u.squashnetRanking?.clt ?? null,
    cltOverride: u.interclubCltOverride,
    cltSource: u.interclubCltOverride ? "override" : u.squashnetRanking ? "squashnet" : null,
    bookingsApp: originByUser.get(u.id)?.app ?? 0,
    bookingsResa: originByUser.get(u.id)?.resa ?? 0,
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
