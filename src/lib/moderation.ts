// Modération des demandes de compte (étape 3 de l'admin) : historique des décisions
// (append-only, découplé des jetons EmailToken) + blocklist d'e-mails.

import { prisma } from "./db";
import { normalizeEmail } from "./session";
import { MODERATION_RETENTION_MS } from "./retention";

export type Outcome = "approved" | "rejected";

/**
 * Purge des traces sorties de la fenêtre de rétention. Opportuniste (au fil des accès) plutôt
 * que par un cron dédié : même approche que `LoginAttempt` et `FeedbackMessage`, et le plan
 * Vercel plafonne le nombre de crons. Best-effort — ne doit JAMAIS faire échouer l'action qui
 * l'a déclenchée (journaliser une décision reste plus important que nettoyer).
 */
export async function purgeExpiredModeration(): Promise<void> {
  const cutoff = new Date(Date.now() - MODERATION_RETENTION_MS);
  try {
    await prisma.requestLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma.emailBlock.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (e) {
    console.error("[moderation] purge de rétention impossible", e);
  }
}

/** Journalise une décision admin (approbation / rejet) pour la traçabilité. Best-effort. */
export async function logRequestDecision(entry: {
  email: string;
  purpose: string;
  displayName?: string | null;
  outcome: Outcome;
  decidedById?: string | null;
}): Promise<void> {
  // Deuxième point de purge (avec la lecture de l'historique) : garantit que la rétention
  // s'applique même si personne n'ouvre jamais /admin/demandes.
  await purgeExpiredModeration();
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
  // Purge avant lecture : l'admin ne doit jamais voir une trace qu'on annonce comme supprimée.
  await purgeExpiredModeration();
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
