// Utilitaires de date calendaire (YYYY-MM-DD), partagés entre la page (client) et le
// préchargement serveur (SSR). Distinct de time.ts (horaires DANS un créneau).

export function toISODate(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

const CLUB_TZ = "Europe/Paris";

/**
 * Jour d'ouverture par défaut, calculé côté SERVEUR (SSR) : aujourd'hui, ou demain s'il
 * est déjà tard (≥ 21 h) — il ne reste alors plus guère de créneaux jouables le soir même.
 * Fixe explicitement le fuseau du club (Europe/Paris) : une fonction Vercel tourne en UTC
 * par défaut, pas garanti aligné avec l'heure locale qui définit la règle des 21 h.
 */
export function defaultOpenDateParis(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLUB_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  return Number(get("hour")) >= 21 ? addDays(today, 1) : today;
}
