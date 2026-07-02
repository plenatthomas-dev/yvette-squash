// Types « normalisés » de l'appli. On convertit la réponse brute de ResaMania vers ces types
// pour que le reste de l'appli ne dépende jamais du format exact de l'API.

export type SlotStatus = "free" | "booked" | "closed";

export interface Court {
  id: string; // IRI studio, ex. "/lecomplexbures/studios/5382"
  name: string; // ex. "Squash 1"
}

export interface Slot {
  id: string; // IRI class_event, ex. "/lecomplexbures/class_events/25312903"
  courtId: string;
  courtName: string;
  startsAt: string; // ISO 8601
  endsAt: string; // ISO 8601
  status: SlotStatus;
  bookable: boolean;
  remaining: number; // places restantes (attendeeRemaining)
  bookerContactId?: string | null; // contactId (opaque) de la personne ayant réservé, si pris
  bookedBy?: string | null; // nom résolu si la personne est un membre connu du groupe
  mine?: boolean; // true si c'est le joueur courant qui a réservé ce créneau
  attendees?: string[]; // prénoms des membres « présents » (hors réservataire), signal local
  iAmAttending?: boolean; // true si le joueur courant s'est noté présent sur ce créneau
}

export interface PlanningDay {
  date: string; // YYYY-MM-DD
  clubId: string;
  courts: Court[];
  slots: Slot[];
}

export interface ResaCredentials {
  username: string;
  password: string;
}

// Identité du joueur, déduite du JWT + d'un appel /contact_users. Sert au payload de réservation.
export interface ResaIdentity {
  contactUserId: string; // "12456439"
  contactId: string; // "/lecomplexbures/contacts/12685397"
  contactNumber: string; // "C12685397"
  clubId: string; // "/lecomplexbures/clubs/2345"
  familyName: string;
  givenName: string;
  email: string;
  contactCreatedAt: string;
}

export interface ResaSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  identity: ResaIdentity;
}

export interface BookResult {
  ok: boolean;
  attendeeId?: string; // IRI de l'attendee créé (sert à annuler)
  state?: string; // "booked" | "queued" | ...
  error?: string;
}
