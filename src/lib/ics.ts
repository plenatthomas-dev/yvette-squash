// Génération d'un fichier iCalendar (.ics) pour ajouter une réservation à son agenda perso.
// 100 % côté client : aucune donnée n'est envoyée à un serveur, on exporte juste SA propre
// réservation (déjà affichée) vers SON agenda. RFC 5545.

// Lieu du club, tel qu'il apparaîtra dans l'agenda (géocodable par Google/Apple Agenda).
export const CLUB_LOCATION =
  "Le Complexe, 9 rue de la Vierge, 91440 Bures-sur-Yvette";

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

// Déclenche le téléchargement d'un .ics (l'ouverture ajoute l'évènement à l'agenda).
function telecharger(contenu: string, nom: string): void {
  const blob = new Blob([contenu], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadIcs(ev: IcsEvent): void {
  telecharger(buildIcs(ev), icsFilename(ev));
}

// ============================================================================
//  UNE RENCONTRE D'INTERCLUB DANS L'AGENDA.
//
//  Une réservation et une rencontre ne demandent pas le même évènement, et les
//  trois différences comptent toutes :
//
//   1. LE LIEU N'EST PAS LE CLUB. En déplacement, on ne sait pas d'avance chez
//      qui l'on va — c'est l'information la plus utile de tout l'écran, et
//      celle qu'un agenda sait rendre cliquable en itinéraire.
//   2. L'HEURE PEUT MANQUER. La ligue publie des journées avant d'en fixer
//      l'horaire. On n'en invente pas une : l'évènement devient une JOURNÉE
//      ENTIÈRE, qui apparaît quand même dans l'agenda et ne fait venir
//      personne à 20 h pour rien.
//   3. LA DATE PEUT ÊTRE PRÉVISIONNELLE. Exporter une date bouchon en la
//      faisant passer pour ferme est exactement ce que le reste du module
//      refuse (cf. `dateConfirmed`) : le titre le dit.
//
//  ⚠️ HEURE FLOTTANTE, ET NON UTC. Tout le module interclub raisonne en heure
//  locale du club : `date` et `time` sont des chaînes murales, jamais des
//  instants. Les convertir en UTC ici demanderait de connaître le fuseau du
//  club au moment de l'export — et se tromperait deux fois par an. Un
//  `DTSTART` sans `Z` est une heure LOCALE au sens de la RFC 5545 : « 20 h là
//  où tu es », ce qui est exactement ce que dit le calendrier fédéral.
// ============================================================================

/** Une rencontre à exporter — sous-ensemble de ce que la fiche affiche déjà. */
export interface IcsFixture {
  id: string;
  /** « YYYY-MM-DD ». */
  date: string;
  /** « HH:MM », ou null quand la ligue ne l'a pas encore publiée. */
  time: string | null;
  teamName: string;
  opponent: string;
  /** Vrai si l'on reçoit. */
  home: boolean;
  venue: string | null;
  venueAddress: string | null;
  /** Faux = date prévisionnelle, la ligue ne l'a pas encore fixée. */
  dateConfirmed: boolean;
}

/** Durée retenue pour une rencontre : quatre simples ne tiennent pas en une heure. */
const FIXTURE_HOURS = 3;

/** « 2026-09-03 » + « 20:00 » → « 20260903T200000 » (heure flottante, cf. l'en-tête). */
function localStamp(date: string, time: string): string {
  return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
}

/** Le lendemain d'une date ISO, pour le `DTEND` exclusif d'un évènement de journée. */
function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** L'heure de fin, bornée à la même journée : une rencontre à 22 h ne déborde pas sur demain. */
function endTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(Math.min(23, h + FIXTURE_HOURS)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function buildFixtureIcs(f: IcsFixture): string {
  // « reçoit » / « chez » plutôt qu'un tiret : dans une liste d'agenda, on cherche d'abord à
  // savoir si l'on se déplace. Le nom de notre équipe reste en tête — c'est le sien qu'on
  // reconnaît d'un coup d'œil parmi vingt évènements.
  const rencontre = f.home
    ? `${f.teamName} reçoit ${f.opponent}`
    : `${f.teamName} chez ${f.opponent}`;
  const summary = `Interclub — ${rencontre}${f.dateConfirmed ? "" : " (date prévisionnelle)"}`;
  // À domicile et sans lieu publié, c'est chez nous : l'adresse du club est connue et vaut
  // mieux qu'un évènement sans lieu, qu'aucun agenda ne sait géocoder.
  const lieu = f.venue
    ? [f.venue, f.venueAddress].filter(Boolean).join(", ")
    : f.home
      ? CLUB_LOCATION
      : "";

  const debut = f.time
    ? [`DTSTART:${localStamp(f.date, f.time)}`, `DTEND:${localStamp(f.date, endTime(f.time))}`]
    : // Journée entière : le `DTEND` d'un évènement `VALUE=DATE` est EXCLUSIF — sans le
      // lendemain, l'évènement dure zéro jour et certains agendas ne l'affichent pas.
      [
        `DTSTART;VALUE=DATE:${f.date.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${nextDay(f.date)}`,
      ];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yvette Squash//Interclub//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // Préfixé : une rencontre et une réservation peuvent partager un identifiant sans que
    // l'agenda prenne l'une pour une mise à jour de l'autre.
    `UID:ic-${f.id.replace(/[^\w-]/g, "-")}@yvette-squash`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    ...debut,
    `SUMMARY:${esc(summary)}`,
    ...(lieu ? [`LOCATION:${esc(lieu)}`] : []),
    // L'alarme n'a de sens que sur une heure connue : à J-2 h on part de chez soi. Sur un
    // évènement de journée, elle sonnerait à minuit.
    ...(f.time
      ? [
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `DESCRIPTION:${esc(`Rencontre dans 2 h : ${rencontre}`)}`,
          "TRIGGER:-PT2H",
          "END:VALARM",
        ]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export function downloadFixtureIcs(f: IcsFixture): void {
  telecharger(buildFixtureIcs(f), `interclub-${f.date}.ics`);
}
