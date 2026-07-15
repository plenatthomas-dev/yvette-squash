// Modération des demandes de compte (étape 3 de l'admin) : historique des décisions
// (append-only, découplé des jetons EmailToken) + blocklist d'e-mails.

import { prisma } from "./db";
import { normalizeEmail } from "./session";

export type Outcome = "approved" | "rejected";

/** Journalise une décision admin (approbation / rejet) pour la traçabilité. Best-effort. */
export async function logRequestDecision(entry: {
  email: string;
  purpose: string;
  displayName?: string | null;
  outcome: Outcome;
  decidedById?: string | null;
}): Promise<void> {
  await prisma.requestLog.create({
    data: {
      email: entry.email,
      purpose: entry.purpose,
      displayName: entry.displayName ?? null,
      outcome: entry.outcome,
      decidedById: entry.decidedById ?? null,
    },
  });
}

/** Historique des demandes traitées, les plus récentes d'abord. */
export async function listRequestHistory(limit = 50) {
  return prisma.requestLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      email: true,
      purpose: true,
      displayName: true,
      outcome: true,
      createdAt: true,
    },
  });
}

// --- Blocklist -----------------------------------------------------------------------------

/** L'e-mail est-il bloqué ? (normalisé avant lecture) */
export async function isEmailBlocked(email: string): Promise<boolean> {
  const row = await prisma.emailBlock.findUnique({ where: { email: normalizeEmail(email) } });
  return !!row;
}

/** Liste de la blocklist (plus récents d'abord). */
export async function listBlocks() {
  return prisma.emailBlock.findMany({
    orderBy: { createdAt: "desc" },
    select: { email: true, reason: true, createdAt: true },
  });
}

/** Ajoute (ou met à jour la note) d'un e-mail bloqué. Renvoie l'e-mail normalisé. */
export async function addBlock(
  email: string,
  reason: string | null,
  createdById: string | null,
): Promise<string> {
  const normalized = normalizeEmail(email);
  await prisma.emailBlock.upsert({
    where: { email: normalized },
    create: { email: normalized, reason, createdById },
    update: { reason },
  });
  return normalized;
}

/** Retire un e-mail de la blocklist. */
export async function removeBlock(email: string): Promise<void> {
  await prisma.emailBlock.deleteMany({ where: { email: normalizeEmail(email) } });
}
