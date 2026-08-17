// Libellé « origine des réservations » du tableau de bord admin. Logique pure (aucun accès
// base, aucun import serveur) pour rester testable et utilisable depuis un composant client.

export type BookingOriginCounts = {
  /** Résas actives (30 j) faites via l'appli. */
  bookingsApp: number;
  /** Résas actives (30 j) détectées comme faites directement sur ResaMania. */
  bookingsResa: number;
  /** État du flag `externalBookings` : sans lui, `bookingsResa` vaut 0 par construction. */
  externalDetection: boolean;
};

/**
 * Sous-titre du compteur de résas : part faite via l'appli vs directement sur ResaMania.
 *
 * Trois cas à ne PAS confondre — c'est tout l'intérêt de l'indicateur :
 *  - détection coupée      ⇒ on ne SAIT pas (bookingsResa vaut 0 par construction) ;
 *  - détection active, 0   ⇒ personne n'a réservé hors appli sur les jours consultés ;
 *  - détection active, n>0 ⇒ n résas faites hors appli.
 *
 * ⚠️ Même détection active, le compte « hors appli » est un PLANCHER : la réconciliation ne
 * voit que les jours effectivement ouverts dans l'appli par un membre à jeton ResaMania.
 */
export function bookingOriginHint(d: BookingOriginCounts): string {
  if (!d.externalDetection) return "origine non détectée";
  const total = d.bookingsApp + d.bookingsResa;
  if (total === 0) return "aucune résa";
  const pct = Math.round((d.bookingsApp / total) * 100);
  return `${pct} % via l'appli · ${d.bookingsResa} hors appli`;
}
