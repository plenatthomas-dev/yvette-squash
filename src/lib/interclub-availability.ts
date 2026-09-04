// ============================================================================
//  DISPONIBILITÉS — les règles PURES, sans base ni réseau.
//
//  « Qui peut venir jeudi ? » remplace un fil de discussion où la question se
//  repose chaque semaine, où les réponses se comptent à la main, et où celui
//  qui n'a rien dit se confond avec celui qui a dit non.
// ============================================================================

/**
 * Trois états, pas deux.
 *
 * « maybe » n'est pas une commodité : sans lui, celui qui ne sait pas encore répond « non »
 * (le choix qui n'engage pas), et l'équipe perd un joueur disponible. Il ne compte jamais
 * comme un présent pour le capitaine, et se relance comme une absence de réponse.
 */
export const AVAILABILITY_STATUSES = ["yes", "no", "maybe"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export function isAvailabilityStatus(v: unknown): v is AvailabilityStatus {
  return typeof v === "string" && (AVAILABILITY_STATUSES as readonly string[]).includes(v);
}

/**
 * L'ordre d'AFFICHAGE des trois réponses — et il n'est pas celui de `AVAILABILITY_STATUSES`,
 * qui suit la fréquence attendue. Les trois boutons forment une ÉCHELLE : on la lit du oui au
 * non, avec l'incertain entre les deux. Rendus dans l'ordre de déclaration, ils donnaient
 * « Dispo · Pas dispo · Incertain », où le milieu de l'échelle se lit après son extrémité.
 */
export const AVAILABILITY_ORDER: readonly AvailabilityStatus[] = ["yes", "maybe", "no"];

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  yes: "Dispo",
  maybe: "Incertain",
  no: "Pas dispo",
};

/**
 * Commentaire libre (« je peux, mais pas avant 20h30 », « je conduis »). Court exprès : c'est
 * une précision, pas une conversation — et il est lu par toute l'équipe.
 */
export const MAX_AVAILABILITY_COMMENT = 200;

/** Normalise un commentaire : espaces compactés, tronqué, vide ⇒ null. */
export function parseComment(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ").slice(0, MAX_AVAILABILITY_COMMENT);
  return t || null;
}

/** Une réponse, telle que l'écran la reçoit. */
export interface AvailabilityEntry {
  /** Identifiant du joueur : `id` du membre, ou `guest:<id>` pour un joueur sans compte. */
  key: string;
  name: string;
  /** Faux pour un joueur sans compte — il ne recevra jamais de notification. */
  isMember: boolean;
  status: AvailabilityStatus | null;
  comment: string | null;
  /**
   * Nom de la personne qui a saisi, quand ce N'EST PAS l'intéressé. Null pour une réponse de
   * première main. C'est ce qui distingue « il a dit oui » de « on a dit qu'il dirait oui »,
   * et l'écran l'affiche — c'est la trace, et non la restriction, qui rend le relais sûr.
   */
  relayedBy: string | null;
  /**
   * Peut-on l'atteindre par notification ? Faux pour un joueur sans compte, et pour un membre
   * qui n'a pas activé les notifications. Sans cette information, le capitaine relance en
   * aveugle des gens que la relance n'atteindra jamais.
   */
  reachable: boolean;
}

export interface AvailabilityTally {
  yes: number;
  no: number;
  maybe: number;
  /** N'a pas répondu ET peut être relancé par notification. */
  pendingReachable: AvailabilityEntry[];
  /** N'a pas répondu et ne recevra RIEN : la liste d'appels du capitaine. */
  pendingUnreachable: AvailabilityEntry[];
}

/**
 * Compte les réponses et sépare les silencieux en deux.
 *
 * La distinction joignable / injoignable est le cœur du dispositif : relancer par notification
 * quelqu'un qui n'en reçoit pas ne coûte rien mais ne produit rien, et laisse croire que le
 * travail est fait. Les deux populations demandent deux gestes différents — attendre, ou
 * décrocher son téléphone.
 */
export function tally(entries: AvailabilityEntry[]): AvailabilityTally {
  const t: AvailabilityTally = { yes: 0, no: 0, maybe: 0, pendingReachable: [], pendingUnreachable: [] };
  for (const e of entries) {
    if (e.status === "yes") t.yes++;
    else if (e.status === "no") t.no++;
    else if (e.status === "maybe") t.maybe++;
    else (e.reachable ? t.pendingReachable : t.pendingUnreachable).push(e);
  }
  return t;
}

/**
 * L'équipe est-elle en difficulté pour cette rencontre ?
 *
 * On compare les « dispo » FERMES au nombre de simples à jouer. Les « incertain » n'entrent
 * pas dans le compte : c'est précisément ce qu'ils veulent dire, et les compter comme présents
 * ferait taire l'alerte le jour où elle est le plus utile.
 */
export function isShortHanded(t: AvailabilityTally, matchCount: number): boolean {
  return t.yes < matchCount;
}

/**
 * Un relais doit-il être confirmé avant d'écraser la réponse existante ?
 *
 * Vrai uniquement quand on remplace une réponse que l'intéressé a donnée LUI-MÊME par une
 * réponse donnée en son nom. Les trois autres cas passent sans rien demander :
 *   * l'intéressé qui se corrige — c'est sa réponse, il en fait ce qu'il veut ;
 *   * un relais qui en remplace un autre — deux ouï-dire se valent ;
 *   * une première réponse, qui ne remplace rien.
 *
 * Ce n'est pas un verrou : le capitaine qui a eu la personne au téléphone confirme et passe.
 * C'est une garantie que personne ne fait disparaître un « non » assumé sans l'avoir vu.
 */
export function needsOverrideConfirm(
  existing: { userId: string | null; setById: string } | null,
  subjectUserId: string | null,
  actorUserId: string,
): boolean {
  if (!existing) return false;
  if (actorUserId === subjectUserId) return false; // l'intéressé se corrige
  return existing.userId !== null && existing.setById === existing.userId;
}

// --- Le calendrier des relances -------------------------------------------------------------

/**
 * Quand ouvrir l'appel, et quand relancer les silencieux.
 *
 * DIX JOURS pour ouvrir : assez tôt pour qu'on puisse encore déplacer une soirée ou trouver un
 * remplaçant, assez tard pour qu'on sache déjà ce qu'on fait ce jeudi-là. Ouvrir un mois avant
 * ne récolterait que des « incertain ».
 *
 * TROIS JOURS pour relancer : c'est le dernier moment où le capitaine peut encore décrocher son
 * téléphone. Relancer la veille n'apporte plus qu'un constat.
 */
export const CALL_DAYS_BEFORE = 10;
export const REMIND_DAYS_BEFORE = 3;

/**
 * Nombre de jours entiers entre deux dates « YYYY-MM-DD », sans passer par un fuseau.
 *
 * Les deux dates sont des dates MURALES (celles qu'on lit sur le calendrier du club) : les
 * convertir en instants introduirait un décalage à chaque changement d'heure, et une relance
 * partirait un jour trop tôt deux fois par an. On compte donc des jours, à midi UTC, où aucun
 * décalage horaire ne peut faire basculer la date.
 */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T12:00:00Z`);
  const b = Date.parse(`${toISO}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Une rencontre, réduite à ce dont le cron a besoin pour décider quoi envoyer. */
export interface ScheduledFixture {
  date: string;
  dateConfirmed: boolean;
  availabilityOpenedAt: Date | null;
  availabilityRemindedAt: Date | null;
}

/**
 * Que faut-il envoyer aujourd'hui pour cette rencontre ?
 *
 * ⚠️ RIEN, JAMAIS, SUR UNE DATE NON CONFIRMÉE. La fédération publie les journées non encore
 * planifiées avec une date bouchon commune : convoquer l'équipe sur cette base l'enverrait
 * quatre fois le même soir, et lui apprendrait à ignorer ces notifications.
 *
 * Les marqueurs (`availabilityOpenedAt`, `availabilityRemindedAt`) portent l'idempotence :
 * sans eux, un cron quotidien redemanderait chaque matin à la même équipe si elle est
 * disponible. Une rencontre PASSÉE ne déclenche rien non plus — `daysBetween` devient négatif,
 * et les deux fenêtres se ferment.
 */
export function dueAction(
  f: ScheduledFixture,
  today: string,
): "call" | "remind" | null {
  if (!f.dateConfirmed) return null;
  const jours = daysBetween(today, f.date);
  if (Number.isNaN(jours) || jours < 0) return null;
  if (!f.availabilityOpenedAt) return jours <= CALL_DAYS_BEFORE ? "call" : null;
  if (!f.availabilityRemindedAt) return jours <= REMIND_DAYS_BEFORE ? "remind" : null;
  return null;
}
