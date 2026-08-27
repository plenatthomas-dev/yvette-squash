import { describe, it, expect } from "vitest";
import { stampFR } from "./time";

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
