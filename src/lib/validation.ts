// Validation d'entrée partagée par les routes API. Toutes les routes qui reçoivent
// un identifiant de class_event doivent utiliser CETTE regex (une seule source de
// vérité), pour ne pas laisser passer un IRI fantaisiste sur /book ou /cancel-slot
// alors que /presence le contrôle.

// IRI d'un class_event ResaMania, ex. "/lecomplexbures/class_events/25312903".
export const CLASS_EVENT_IRI = /^\/[a-z0-9_-]+\/class_events\/\d+$/i;

/** true si `v` est un IRI de class_event plausible. */
export function isClassEventId(v: unknown): v is string {
  return typeof v === "string" && CLASS_EVENT_IRI.test(v);
}
