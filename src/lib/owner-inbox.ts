import { prisma } from "@/lib/db";

// La boîte du propriétaire de l'appli : celle qui reçoit les « Un commentaire ? » des
// Paramètres ET les demandes de suppression de compte. Surchargeable par variable d'env.
//
// UN SEUL QUOTA POUR LES DEUX CANAUX, et c'est voulu : ce qu'on protège, c'est la boîte, pas
// le formulaire. Deux compteurs séparés doubleraient ce qu'un membre peut y déverser. Le plafond
// reste assez large pour qu'aucun usage honnête ne le touche — une demande de suppression ne
// s'envoie qu'une fois.
export const OWNER_INBOX = process.env.FEEDBACK_TO_EMAIL ?? "plenat.thomas@gmail.com";

// Au-delà de OWNER_MAX_PER_DAY envois en OWNER_WINDOW_MS pour un même membre, on refuse. Le
// compteur vit en base — les fonctions serverless n'ont pas de mémoire partagée — sur le même
// modèle que le rate limiting du login.
export const OWNER_WINDOW_MS = 24 * 60 * 60_000; // 24 h glissantes
export const OWNER_MAX_PER_DAY = 10;

/** Nombre de messages envoyés par ce membre au propriétaire sur la fenêtre glissante. */
export async function ownerMessagesRecently(userId: string): Promise<number> {
  const since = new Date(Date.now() - OWNER_WINDOW_MS);
  // Purge opportuniste des lignes hors fenêtre (tous membres : garde la table minuscule).
  await prisma.feedbackMessage.deleteMany({ where: { createdAt: { lt: since } } });
  return prisma.feedbackMessage.count({ where: { userId, createdAt: { gte: since } } });
}

/** Journalise un envoi RÉUSSI pour le compteur (un envoi échoué ne doit pas compter). */
export async function recordOwnerMessage(userId: string): Promise<void> {
  await prisma.feedbackMessage.create({ data: { userId } }).catch(() => {});
}
