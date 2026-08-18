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

export type MemberOrigin = {
  /** Le compte porte-t-il un contactId ResaMania ? (cf. MemberRow.mode) */
  linked: boolean;
  bookingsApp: number;
  bookingsResa: number;
};

/**
 * Libellé « origine des résas » d'UN membre, pour /admin/membres.
 *
 * Un état de plus que l'agrégat du tableau de bord, et c'est le plus important : un compte
 * NON LIÉ (« email seul », `contactId` null) est structurellement indétectable. La
 * réconciliation résout le réservataire par son contactId — sans lui, ses résas ResaMania
 * ne sont rattachées à personne. Afficher « 0 sur ResaMania » pour ce membre serait faux :
 * on ne sait pas, et c'est précisément le profil qu'on aimerait mesurer.
 *
 * Rappel valable même sur un compte lié : le compteur « sur ResaMania » est un PLANCHER
 * (seuls les jours ouverts dans l'appli par un membre à jeton sont analysés).
 */
export function memberOriginLabel(m: MemberOrigin, externalDetection: boolean): string {
  if (!externalDetection) return "origine non détectée";
  if (!m.linked) {
    // Cas de bord : un compte non lié ne possède normalement aucune résa (réserver exige un
    // jeton ResaMania, et une résa par délégation appartient au DÉLÉGANT). Si malgré tout il
    // en porte, on l'affiche — ce chiffre-là est certain — sans rien prétendre sur ResaMania.
    return m.bookingsApp > 0
      ? `${m.bookingsApp} via l'appli · ResaMania non détectable`
      : "compte non lié à ResaMania";
  }
  if (m.bookingsApp + m.bookingsResa === 0) return "aucune résa";
  return `${m.bookingsApp} via l'appli · ${m.bookingsResa} sur ResaMania`;
}
