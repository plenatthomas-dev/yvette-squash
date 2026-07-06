// Génération d'un fichier iCalendar (.ics) pour ajouter une réservation à son agenda perso.
// 100 % côté client : aucune donnée n'est envoyée à un serveur, on exporte juste SA propre
// réservation (déjà affichée) vers SON agenda. RFC 5545.

// Lieu du club, tel qu'il apparaîtra dans l'agenda (géocodable par Google/Apple Agenda).
export const CLUB_LOCATION = "Le Complexe, Bures-sur-Yvette";

// Un évènement à exporter — sous-ensemble commun à `JournalEntry` et `Slot`.
export interface IcsEvent {
  id: string; // identifiant stable (IRI ResaMania) → sert d'UID
  courtName: string; // ex. "Squash 1"
  startsAt: string; // ISO 8601
  endsAt: string; // ISO 8601
}

// Échappe les caractères réservés d'une valeur TEXT (virgule, point-virgule, backslash, saut
// de ligne) — sinon un « , » dans le lieu casserait le parsing.
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Date ISO -> format UTC iCal « 20260706T150000Z » (pas d'ambiguïté de fuseau).
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Construit le contenu .ics d'UNE réservation, avec une alarme 1 h avant et le lieu du club.
export function buildIcs(ev: IcsEvent): string {
  const uid = `${ev.id.replace(/[^\w-]/g, "-")}@yvette-squash`;
  const summary = `Squash — ${ev.courtName}`;
  // Lignes en CRLF (RFC 5545). Alarme DISPLAY déclenchée à -1 h.
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yvette Squash//Reservation//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    `DTSTART:${toIcsUtc(ev.startsAt)}`,
    `DTEND:${toIcsUtc(ev.endsAt)}`,
    `SUMMARY:${esc(summary)}`,
    `LOCATION:${esc(CLUB_LOCATION)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(`Rappel : ${summary} dans 1 h`)}`,
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

// Nom de fichier lisible : « squash-2026-07-06-1500.ics ».
function icsFilename(ev: IcsEvent): string {
  const d = new Date(ev.startsAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `squash-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}.ics`;
}

// Déclenche le téléchargement du .ics (l'ouverture ajoute l'évènement à l'agenda).
export function downloadIcs(ev: IcsEvent): void {
  const blob = new Blob([buildIcs(ev)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = icsFilename(ev);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
