import { describe, it, expect } from "vitest";
import { stampFR, toInstant, clubTodayISO } from "./time";

describe("stampFR", () => {
  it("rend « JJ/MM/AA HH:MM »", () => {
    // 21:30 UTC en août = 23:30 à Paris (heure d'été).
    expect(stampFR("2026-08-27T21:30:00Z")).toBe("27/08/26 23:30");
  });

  it("affiche l'heure MURALE DU CLUB, pas celle du serveur ni du navigateur", () => {
    // Le serveur tourne en UTC sur Vercel : sans fuseau explicite, une notification de
    // 00:30 à Paris s'afficherait la veille à 22:30.
    expect(stampFR("2026-08-27T22:30:00Z")).toBe("28/08/26 00:30");
  });

  it("suit le changement d'heure sans qu'on ait à s'en occuper", () => {
    // Janvier : Paris est à UTC+1, pas +2.
    expect(stampFR("2026-01-15T12:00:00Z")).toBe("15/01/26 13:00");
  });

  it("ne rend rien plutôt qu'une date absurde sur une entrée illisible", () => {
    expect(stampFR("pas une date")).toBe("");
    expect(stampFR("")).toBe("");
  });
});

// `toInstant` fige l'heure MURALE sans fuseau que renvoie ResaMania ("2026-07-07T20:30:00") en
// instant absolu, lue comme heure du club. Toute réservation, tout snapshot et toute alerte en
// dépendent, et elle n'avait aucun test. On fixe son comportement aux heures d'ouverture du
// club, y compris les deux jours de changement d'heure de la saison 2026-27.
describe("toInstant", () => {
  it("été (UTC+2) : 20:30 au club = 18:30 UTC", () => {
    expect(toInstant("2026-07-07T20:30:00")).toBe("2026-07-07T18:30:00.000Z");
  });

  it("hiver (UTC+1) : 09:00 au club = 08:00 UTC", () => {
    expect(toInstant("2026-01-15T09:00:00")).toBe("2026-01-15T08:00:00.000Z");
  });

  it("veille du passage à l'heure d'hiver : encore UTC+2", () => {
    expect(toInstant("2026-10-24T21:20:00")).toBe("2026-10-24T19:20:00.000Z");
  });

  it("dimanche 25/10/2026 (retour à l'heure d'hiver à 3 h) : 07:00 et 21:20 déjà en UTC+1", () => {
    expect(toInstant("2026-10-25T07:00:00")).toBe("2026-10-25T06:00:00.000Z");
    expect(toInstant("2026-10-25T21:20:00")).toBe("2026-10-25T20:20:00.000Z");
  });

  it("dimanche 29/03/2026 (passage à l'heure d'été à 2 h) : 07:00 déjà en UTC+2", () => {
    expect(toInstant("2026-03-29T07:00:00")).toBe("2026-03-29T05:00:00.000Z");
  });

  it("une chaîne déjà datée est seulement normalisée (idempotence)", () => {
    expect(toInstant("2026-07-07T18:30:00Z")).toBe("2026-07-07T18:30:00.000Z");
    expect(toInstant("2026-07-07T20:30:00+02:00")).toBe("2026-07-07T18:30:00.000Z");
    expect(toInstant(toInstant("2026-10-25T07:00:00"))).toBe("2026-10-25T06:00:00.000Z");
  });
});

describe("clubTodayISO", () => {
  it("rend la date du CLUB, pas celle d'UTC", () => {
    // 22:30 UTC en octobre (heure d'été) = 00:30 le lendemain à Paris.
    expect(clubTodayISO(new Date("2026-10-17T22:30:00Z"))).toBe("2026-10-18");
    // En hiver, la bascule a lieu à 23:00 UTC.
    expect(clubTodayISO(new Date("2026-12-31T22:30:00Z"))).toBe("2026-12-31");
    expect(clubTodayISO(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});
