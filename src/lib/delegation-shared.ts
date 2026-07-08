// Constantes de délégation (idée 4) utilisables côté CLIENT (aucune dépendance serveur,
// cf. features.ts). La logique serveur (lib/delegation.ts) réexporte ces mêmes valeurs.

// V1 (cf. docs/delegation-droits.md) : un seul scope possible, pas de granularité fine.
export const DELEGATION_SCOPE = "book_cancel" as const;

// Durées proposées côté UI — bornes dures : limite le rayon si le compte du délégué
// est compromis pendant que la délégation est active.
export const DELEGATION_DURATIONS: { hours: 24 | 72 | 120; label: string }[] = [
  { hours: 24, label: "24 h" },
  { hours: 72, label: "3 jours" },
  { hours: 120, label: "5 jours" },
];

export const DELEGATION_DURATIONS_H = DELEGATION_DURATIONS.map((d) => d.hours) as [
  24,
  72,
  120,
];
