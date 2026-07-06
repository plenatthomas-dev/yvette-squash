// Heure « murale » du club, indépendante du fuseau du serveur ET du navigateur.
//
// Les créneaux arrivent en ISO 8601 (un INSTANT précis). Selon la source, l'heure
// peut être exprimée en UTC (…T07:00:00Z pour 9 h Paris) ou avec un décalage. Parser
// la chaîne « à la main » (regex sur "T09:00") donne donc une heure fausse dès que la
// source n'est pas déjà en heure de Paris. On convertit toujours l'instant vers le
// fuseau du club via Intl → un créneau de 9 h Paris vaut 09:00 partout.

export const CLUB_TZ = "Europe/Paris";

const HHMM = new Intl.DateTimeFormat("fr-FR", {
  timeZone: CLUB_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Heure/minute du créneau dans le fuseau du club (ex. { h: 9, m: 0 }). */
function clubParts(iso: string): { h: number; m: number } {
  const parts = HHMM.formatToParts(new Date(iso));
  const h = +(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = +(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { h, m };
}

/** Minutes depuis minuit, dans le fuseau du club. Sert au filtre matin/après-midi/soir. */
export function slotMinutes(iso: string): number {
  const { h, m } = clubParts(iso);
  return h * 60 + m;
}

/** "HH:MM" affiché en heure du club (ex. "09:00"), quel que soit le téléphone. */
export function fmtTime(iso: string): string {
  const { h, m } = clubParts(iso);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Certaines sources (ResaMania) renvoient une heure « murale » SANS fuseau
// (ex. "2026-07-07T20:30:00") : lue telle quelle, `new Date` l'interprète dans le fuseau
// AMBIANT — Paris dans le navigateur (l'affichage semble bon), mais UTC sur le serveur
// Vercel → l'instant stocké est décalé (+2 h l'été). On réinterprète donc explicitement la
// chaîne comme heure du club et on renvoie un INSTANT absolu (…Z), correct partout.
// Idempotent : une chaîne déjà datée (Z ou ±HH:MM) est simplement normalisée.
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Décalage (ms) du fuseau du club par rapport à UTC à l'instant donné (positif à l'est). */
function clubOffsetMs(instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant))
    if (part.type !== "literal") p[part.type] = +part.value;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/** Normalise une date ISO en instant absolu (…Z), en lisant une heure sans fuseau comme
 *  heure du club (Europe/Paris), DST-safe pour les horaires de journée/soirée. */
export function toInstant(iso: string): string {
  if (HAS_TZ.test(iso)) return new Date(iso).toISOString();
  const asIfUtc = new Date(`${iso}Z`);
  return new Date(asIfUtc.getTime() - clubOffsetMs(asIfUtc)).toISOString();
}
