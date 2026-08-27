// Constantes du journal de notifications partagées entre le SERVEUR et le CLIENT.
//
// Ce module ne doit rien importer de « server-only » — surtout pas prisma. `notify-store.ts`,
// lui, écrit en base : l'importer depuis un composant client tirerait Prisma dans le bundle
// du navigateur. Même séparation que `delegation-shared.ts`.

/**
 * Au-delà, une notification n'intéresse plus personne. Une cloche n'est pas un historique :
 * on y regarde ce qui s'est passé depuis la dernière fois, pas la saison écoulée.
 */
export const NOTIFICATION_RETENTION_DAYS = 30;

/** Nombre de lignes rendues à la cloche. Au-delà, c'est un historique, pas une cloche. */
export const NOTIFICATION_PAGE = 30;
