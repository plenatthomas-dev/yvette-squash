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
