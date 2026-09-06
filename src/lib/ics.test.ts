import { describe, it, expect } from "vitest";
import { buildIcs, buildFixtureIcs, CLUB_LOCATION } from "./ics";

// L'EXPORT VERS L'AGENDA, ÉPROUVÉ SUR LE TEXTE QU'IL PRODUIT.
//
// Un `.ics` est un format que personne ne relit : il part dans l'agenda du téléphone, et s'il
// est faux, ce qu'on voit n'est pas une erreur — c'est un rendez-vous à la mauvaise heure, ou
// pas de rendez-vous du tout. Aucune de ces propriétés ne se vérifie à l'usage sans y aller
// voir, ce qui est exactement ce que fait ce fichier.
//
// Les deux évènements ne se ressemblent pas, et les différences sont toutes voulues :
// une réservation a un lieu connu (le club) et une heure certaine ; une rencontre peut se
// jouer n'importe où, à une heure que la ligue n'a pas encore publiée, à une date qu'elle
// n'a pas encore fixée.

/** Les lignes du fichier, dépliées — la RFC 5545 impose CRLF, et c'est aussi un test. */
const lignes = (ics: string) => ics.split("\r\n");
const ligne = (ics: string, cle: string) => lignes(ics).find((l) => l.startsWith(cle)) ?? null;

const RENCONTRE = {
  id: "cl_f1",
  date: "2026-09-03",
  time: "20:00",
  teamName: "Équipe 1",
  opponent: "Massy",
  home: false,
  venue: "Squash de Massy",
  venueAddress: "12 rue du Stade, 91300 Massy",
  dateConfirmed: true,
};

describe("une réservation", () => {
  it("part en UTC, avec le lieu du club et un rappel 1 h avant", () => {
    const ics = buildIcs({
      id: "resa-1",
      courtName: "Squash 1",
      startsAt: "2026-07-06T13:00:00.000Z",
      endsAt: "2026-07-06T13:45:00.000Z",
    });
    expect(ligne(ics, "DTSTART")).toBe("DTSTART:20260706T130000Z");
    expect(ligne(ics, "LOCATION")).toContain("Bures-sur-Yvette");
    expect(ligne(ics, "TRIGGER")).toBe("TRIGGER:-PT1H");
  });
});

describe("une rencontre d'interclub", () => {
  it("porte le déplacement dans son titre, et le club hôte dans son lieu", () => {
    const ics = buildFixtureIcs(RENCONTRE);
    expect(ligne(ics, "SUMMARY")).toBe(
      "SUMMARY:Interclub — Équipe 1 chez Massy",
    );
    // Le lieu ÉCHAPPÉ : une virgule dans une adresse est le cas normal, et non échappée elle
    // couperait la valeur en deux aux yeux de l'agenda.
    expect(ligne(ics, "LOCATION")).toBe(
      "LOCATION:Squash de Massy\\, 12 rue du Stade\\, 91300 Massy",
    );
  });

  it("dit « reçoit » quand on reçoit, et retombe sur l'adresse du club sans lieu publié", () => {
    const ics = buildFixtureIcs({ ...RENCONTRE, home: true, venue: null, venueAddress: null });
    expect(ligne(ics, "SUMMARY")).toBe("SUMMARY:Interclub — Équipe 1 reçoit Massy");
    // Mieux que pas de lieu du tout : un évènement sans `LOCATION` n'est géocodable par aucun
    // agenda, et à domicile on sait parfaitement où l'on joue.
    expect(ligne(ics, "LOCATION")).toBe(`LOCATION:${CLUB_LOCATION.replace(/,/g, "\\,")}`);
  });

  // L'HEURE EST FLOTTANTE, ET C'EST LE POINT. Tout le module interclub raisonne en heure
  // MURALE du club : `date` et `time` sont des chaînes, jamais des instants. Un `DTSTART`
  // avec `Z` demanderait de connaître le fuseau du club à l'export, et se tromperait deux
  // fois par an — précisément aux deux journées de championnat qui encadrent le changement
  // d'heure.
  it("écrit une heure LOCALE, sans Z, et une fin trois heures plus tard", () => {
    const ics = buildFixtureIcs(RENCONTRE);
    expect(ligne(ics, "DTSTART")).toBe("DTSTART:20260903T200000");
    expect(ligne(ics, "DTEND")).toBe("DTEND:20260903T230000");
    expect(ics).not.toContain("T200000Z");
  });

  it("n'invente pas d'heure : sans horaire publié, c'est une JOURNÉE entière", () => {
    // La ligue publie des journées avant d'en fixer l'horaire. Poser 20 h par défaut ferait
    // venir quelqu'un à 20 h pour rien ; ne rien exporter le priverait du rendez-vous.
    const ics = buildFixtureIcs({ ...RENCONTRE, time: null });
    expect(ligne(ics, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260903");
    // Le `DTEND` d'un évènement de journée est EXCLUSIF : sans le lendemain, l'évènement dure
    // zéro jour et certains agendas ne l'affichent pas.
    expect(ligne(ics, "DTEND")).toBe("DTEND;VALUE=DATE:20260904");
    // Pas d'alarme : sur une journée entière, elle sonnerait à minuit.
    expect(ics).not.toContain("BEGIN:VALARM");
  });

  it("ne déborde pas sur le lendemain quand la rencontre commence tard", () => {
    const ics = buildFixtureIcs({ ...RENCONTRE, time: "22:30" });
    expect(ligne(ics, "DTEND")).toBe("DTEND:20260903T233000");
  });

  it("DIT qu'une date est prévisionnelle plutôt que de la faire passer pour ferme", () => {
    // La fédération publie les journées non planifiées avec une date bouchon commune. Exporter
    // celle-ci sans réserve est exactement ce que le reste du module refuse de faire.
    const ics = buildFixtureIcs({ ...RENCONTRE, dateConfirmed: false });
    expect(ligne(ics, "SUMMARY")).toContain("(date prévisionnelle)");
  });

  it("prévient deux heures avant — on part de chez soi bien avant le coup d'envoi", () => {
    expect(ligne(buildFixtureIcs(RENCONTRE), "TRIGGER")).toBe("TRIGGER:-PT2H");
  });

  it("porte un UID distinct de celui d'une réservation de même identifiant", () => {
    // Sans préfixe, un agenda prendrait l'un pour une mise à jour de l'autre et n'en garderait
    // qu'un seul.
    const rencontre = ligne(buildFixtureIcs({ ...RENCONTRE, id: "x1" }), "UID");
    const resa = ligne(
      buildIcs({
        id: "x1",
        courtName: "Squash 1",
        startsAt: "2026-09-03T18:00:00.000Z",
        endsAt: "2026-09-03T18:45:00.000Z",
      }),
      "UID",
    );
    expect(rencontre).toBe("UID:ic-x1@yvette-squash");
    expect(rencontre).not.toBe(resa);
  });

  it("sépare ses lignes en CRLF, comme la RFC l'exige", () => {
    const ics = buildFixtureIcs(RENCONTRE);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR")).toBe(true);
  });
});
