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
