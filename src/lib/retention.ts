// Durées de conservation : ANNONCÉES dans la note de confidentialité et APPLIQUÉES par le code.
//
// Un seul endroit pour les deux, volontairement : une note qui promet une durée que le code ne
// tient pas est pire que pas de note du tout. La note lit l'étiquette, `moderation.ts` purge
// avec la durée — ils ne peuvent plus diverger.
//
// Module PUR : aucun import serveur (prisma…), il doit rester utilisable depuis un composant
// client (cf. components/PrivacyNotice.tsx).

/** Traces de modération (historique des décisions + blocklist) : 12 mois. */
export const MODERATION_RETENTION_DAYS = 365;
export const MODERATION_RETENTION_MS = MODERATION_RETENTION_DAYS * 24 * 60 * 60_000;
/** Formulation affichée aux membres. Doit décrire la constante ci-dessus. */
export const MODERATION_RETENTION_LABEL = "12 mois";

/**
 * Cache du planning (`PlanningSnapshot`) : 7 jours après la date du créneau.
 *
 * Ce n'est pas qu'une question de place. Le snapshot est le planning BRUT de ResaMania : il
 * contient le `contactId` du réservataire de chaque créneau — donc de personnes qui ne sont PAS
 * membres de l'appli et n'ont rien accepté. On le garde parce que les comptes « email seul »
 * (sans jeton ResaMania) n'ont que lui pour voir le planning ; mais le planning d'un jour PASSÉ
 * ne sert plus à personne, alors que la donnée, elle, resterait.
 */
export const SNAPSHOT_RETENTION_DAYS = 7;
/** Formulation affichée aux membres. Doit décrire la constante ci-dessus. */
export const SNAPSHOT_RETENTION_LABEL = "7 jours";
