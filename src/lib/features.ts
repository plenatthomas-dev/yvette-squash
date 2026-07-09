// Feature flags pilotés par variables d'environnement NEXT_PUBLIC_* : la même
// variable est lisible côté CLIENT (masquer l'UI) et côté SERVEUR (refuser l'API),
// donc un seul flag suffit à couper une fonction de bout en bout.
//
// Règle : un flag est ACTIVÉ uniquement si sa valeur vaut "1", "true" ou "on"
// (insensible à la casse). Absent ou toute autre valeur ⇒ DÉSACTIVÉ. Défaut
// « fail-safe » : rien de sensible n'est exposé tant qu'on ne l'active pas
// explicitement — en prod on laisse la variable non définie.
//
// ⚠️ NEXT_PUBLIC_* est inliné au BUILD dans le bundle client : changer la valeur
// en prod nécessite un REDEPLOY (mais pas de changement de code ni de re-merge).
//
// NB : ce module ne doit rien importer de « server-only » (ex. next/server) pour
// rester utilisable depuis les composants client.

function isOn(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on";
}

// Partage de frais (onglet « Frais » / tricount) : UI + routes /api/tricount/**.
export const FEATURE_TRICOUNT = isOn(process.env.NEXT_PUBLIC_FEATURE_TRICOUNT);

// Connexion « email seul » (OTP) : onglet de login + routes /api/auth/otp/**.
export const FEATURE_EMAIL_LOGIN = isOn(process.env.NEXT_PUBLIC_FEATURE_EMAIL_LOGIN);

// Annuaire des membres (idée 6) : bouton « Membres » + route /api/directory.
export const FEATURE_DIRECTORY = isOn(process.env.NEXT_PUBLIC_FEATURE_DIRECTORY);

// Délégation temporaire de droits (idée 4) : UI Réglages + routes /api/delegations/**
// + prise en compte de `onBehalfOf` dans book/cancel-slot/bookings. Sensible (agit avec
// le jeton d'un autre membre) → OFF par défaut tant que le chantier n'est pas bouclé.
export const FEATURE_DELEGATION = isOn(process.env.NEXT_PUBLIC_FEATURE_DELEGATION);

// Module d'organisation de tournois (idée 3) : UI « Tournoi » + routes /api/tournaments/**.
// Poules / tableau à repêchage, invités hors asso, saisie de scores. OFF par défaut.
export const FEATURE_TOURNAMENT = isOn(process.env.NEXT_PUBLIC_FEATURE_TOURNAMENT);

// Classement fédéral (squashnet.fr, source publique) : affiché dans l'annuaire et proposé
// comme ordre par défaut des têtes de série au tournoi. Rafraîchi par le cron warm-rankings.
// N'affiche un classement que pour un membre opt-in (annuaire) rapproché de façon sûre.
export const FEATURE_RANKING = isOn(process.env.NEXT_PUBLIC_FEATURE_RANKING);
