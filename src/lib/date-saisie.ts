// Validation d'une date SAISIE (« YYYY-MM-DD ») par un membre : tricount, invités, tournoi.
//
// POURQUOI CE MODULE EXISTE
// Les trois routes ne vérifiaient que la FORME (`/^\d{4}-\d{2}-\d{2}$/`). « 2026-02-30 »
// passait, et créait un tricount à une date qui n'existe pas ; « 2026-13-01 » passait aussi,
// puis `new Date("2026-13-01T12:00:00")` rendait une date invalide que Prisma refusait — un 500
// nu au lieu d'un 400. `isRealDateISO` (lib/time.ts) tranche la première moitié : la forme ne
// suffit jamais.
//
// La seconde moitié est la PLAGE. Rien ne justifie un tricount en l'an 9999 ni en 0001 : une
// faute de frappe (« 2062 » pour « 2026 ») créerait une soirée que personne ne retrouverait
// dans un historique trié par date. Deux ans de part et d'autre d'aujourd'hui couvrent la
// saisie tardive d'une vieille dépense comme le tournoi qu'on prépare longtemps à l'avance.

import { isRealDateISO } from "./time";

/** Écart maximal, en années, entre une date saisie et aujourd'hui (dans les deux sens). */
export const DATE_SAISIE_MAX_ANS = 2;

/**
 * Vrai si `s` est une date calendaire RÉELLE au format « YYYY-MM-DD », à moins de
 * `DATE_SAISIE_MAX_ANS` ans d'aujourd'hui. `now` n'existe que pour les tests.
 *
 * L'écart se compte en jours (365,25 par an) à midi UTC, comme `isRealDateISO` : à quelques
 * heures près au bord de la plage, peu importe — c'est une borne de vraisemblance, pas une
 * règle métier.
 */
export function dateSaisieRecevable(s: unknown, now: number = Date.now()): s is string {
  if (typeof s !== "string" || !isRealDateISO(s)) return false;
  const ecart = Math.abs(Date.parse(`${s}T12:00:00Z`) - now);
  return ecart <= DATE_SAISIE_MAX_ANS * 365.25 * 864e5;
}
