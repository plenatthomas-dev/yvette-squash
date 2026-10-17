import { prisma } from "./db";
import { getResaTokenForUser } from "./session";
import { isResaRefreshTransient } from "./resamania/errors";
import { RESA_UNAVAILABLE_CODE, RESA_UNAVAILABLE_MESSAGE } from "./resamania/responses";
import { getFeatures } from "./features-server";
import { DELEGATION_SCOPE, DELEGATION_DURATIONS_H } from "./delegation-shared";
import type { AppSession } from "./session";
import type { ResaSession } from "./resamania/types";
import type { Delegation } from "@prisma/client";

export { DELEGATION_SCOPE, DELEGATION_DURATIONS_H };

export function isDelegationActive(d: Pick<Delegation, "revokedAt" | "expiresAt">): boolean {
  return !d.revokedAt && d.expiresAt.getTime() > Date.now();
}

/**
 * Délégations que JE (delegatorId) donne actuellement. Plusieurs délégués simultanés
 * possibles (une délégation active au plus par couple délégant/délégué — le POST
 * renouvelle celle d'un même délégué au lieu d'en empiler).
 */
export function getActiveOutgoingDelegations(delegatorId: string) {
  return prisma.delegation.findMany({
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
  // `code` : présent seulement quand l'écran doit pouvoir distinguer le refus (aujourd'hui,
  // la panne ResaMania passagère). Les appelants le relaient tel quel dans le corps JSON.
  | { ok: false; status: number; error: string; code?: string };

/** Refus « ResaMania ne répond pas » : même texte et même code que `resaUnavailableResponse`. */
const RESA_UNAVAILABLE: ActingResult = {
  ok: false,
  status: 503,
  error: RESA_UNAVAILABLE_MESSAGE,
  code: RESA_UNAVAILABLE_CODE,
};

/**
 * Résout le contexte d'action pour book/cancel-slot/bookings : soit sa propre session
 * ResaMania (cas normal), soit celle d'un délégant si `onBehalfOf` est fourni ET couvert
 * par une délégation active (idée 4). `selfRequiredMessage` est le message d'erreur du
 * chemin normal (préservé tel quel par appelant, cf. messages historiques de chaque route).
 *
 * PANNE RESAMANIA PASSAGÈRE → 503 « réessaie dans un instant », sur les deux chemins :
 *  - délégation : `getResaTokenForUser` LÈVE `ResaRefreshTransientError`. On la TRADUIT ici
 *    plutôt que de la laisser remonter : les trois appelants (book, cancel-slot, bookings/[id])
 *    relaient déjà `{ status, error }` tels quels, et c'est le seul endroit où ils obtiennent
 *    le jeton. La laisser filer aurait obligé chacun à l'attraper — trois copies du même
 *    try/catch, et un 500 le jour où une quatrième route l'oublierait. Surtout pas le 409
 *    « session du délégant plus valide » : elle l'est, ResaMania est juste injoignable.
 *  - soi-même : `getSession` a rendu `resaUnavailable` (jeton momentanément irrafraîchissable).
 *    Sans ce test, `!session.resa` ci-dessous répondrait 403 « nécessite une connexion
 *    ResaMania » à un membre qui EN A une.
 */
export async function resolveActingContext(
  session: AppSession,
  onBehalfOf: unknown,
  selfRequiredMessage: string,
): Promise<ActingResult> {
  if (typeof onBehalfOf === "string" && onBehalfOf) {
    if (!(await getFeatures()).delegation) {
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
    let delegatorResa;
    try {
      delegatorResa = await getResaTokenForUser(onBehalfOf);
    } catch (e) {
      if (isResaRefreshTransient(e)) return RESA_UNAVAILABLE;
      throw e; // base en panne, etc. : pas une panne ResaMania, on ne la maquille pas
    }
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
  if (session.resaUnavailable) return RESA_UNAVAILABLE;
  if (!session.resa) {
    return { ok: false, status: 403, error: selfRequiredMessage };
  }
  return {
    ok: true,
    ctx: { resa: session.resa, bookingOwnerId: session.userId, actingUserId: null },
  };
}
