import { prisma } from "./db";
import { getResaTokenForUser } from "./session";
import { FEATURE_DELEGATION } from "./features";
import { DELEGATION_SCOPE, DELEGATION_DURATIONS_H } from "./delegation-shared";
import type { AppSession } from "./session";
import type { ResaSession } from "./resamania/types";
import type { Delegation } from "@prisma/client";

export { DELEGATION_SCOPE, DELEGATION_DURATIONS_H };

export function isDelegationActive(d: Pick<Delegation, "revokedAt" | "expiresAt">): boolean {
  return !d.revokedAt && d.expiresAt.getTime() > Date.now();
}

/** Délégation que JE (delegatorId) donne actuellement — v1 : une seule à la fois. */
export function getActiveOutgoingDelegation(delegatorId: string) {
  return prisma.delegation.findFirst({
    where: { delegatorId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { delegate: { select: { id: true, displayName: true, nickname: true } } },
  });
}

/**
 * Délégations que JE (delegateId) reçois actuellement (pour agir au nom d'un autre).
 * Plusieurs personnes peuvent me déléguer simultanément → on les renvoie TOUTES
 * (le backend d'action, indexé sur le couple délégant/délégataire, gère chacune).
 */
export function getActiveIncomingDelegations(delegateId: string) {
  return prisma.delegation.findMany({
    where: { delegateId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { delegator: { select: { id: true, displayName: true, nickname: true } } },
  });
}

/**
 * Vérifie qu'une action « au nom de » est couverte par une délégation active entre
 * `delegateId` (qui agit) et `delegatorId` (pour le compte de qui). Renvoie la délégation
 * si oui, sinon `null` (l'appelant doit traiter ça comme un accès refusé).
 */
export function findActiveDelegation(delegatorId: string, delegateId: string) {
  return prisma.delegation.findFirst({
    where: { delegatorId, delegateId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

export interface ActingContext {
  resa: ResaSession; // jeton à utiliser pour appeler ResaMania
  bookingOwnerId: string; // à qui appartient la résa (soi-même, ou le délégant)
  actingUserId: string | null; // qui a physiquement déclenché l'action, si délégation
}

type ActingResult =
  | { ok: true; ctx: ActingContext }
  | { ok: false; status: number; error: string };

/**
 * Résout le contexte d'action pour book/cancel-slot/bookings : soit sa propre session
 * ResaMania (cas normal), soit celle d'un délégant si `onBehalfOf` est fourni ET couvert
 * par une délégation active (idée 4). `selfRequiredMessage` est le message d'erreur du
 * chemin normal (préservé tel quel par appelant, cf. messages historiques de chaque route).
 */
export async function resolveActingContext(
  session: AppSession,
  onBehalfOf: unknown,
  selfRequiredMessage: string,
): Promise<ActingResult> {
  if (typeof onBehalfOf === "string" && onBehalfOf) {
    if (!FEATURE_DELEGATION) {
      return { ok: false, status: 404, error: "Délégation désactivée" };
    }
    if (onBehalfOf === session.userId) {
      return { ok: false, status: 400, error: "onBehalfOf invalide." };
    }
    const delegation = await findActiveDelegation(onBehalfOf, session.userId);
    if (!delegation) {
      return {
        ok: false,
        status: 403,
        error: "Délégation introuvable, expirée ou révoquée.",
      };
    }
    const delegatorResa = await getResaTokenForUser(onBehalfOf);
    if (!delegatorResa) {
      return {
        ok: false,
        status: 409,
        error: "La session ResaMania du délégant n'est plus valide.",
      };
    }
    return {
      ok: true,
      ctx: { resa: delegatorResa, bookingOwnerId: onBehalfOf, actingUserId: session.userId },
    };
  }
  if (!session.resa) {
    return { ok: false, status: 403, error: selfRequiredMessage };
  }
  return {
    ok: true,
    ctx: { resa: session.resa, bookingOwnerId: session.userId, actingUserId: null },
  };
}
