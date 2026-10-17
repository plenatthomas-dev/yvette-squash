import { describe, it, expect } from "vitest";
import { dateSaisieRecevable, DATE_SAISIE_MAX_ANS } from "./date-saisie";

const NOW = Date.parse("2026-10-17T12:00:00Z");

describe("dateSaisieRecevable", () => {
  it("accepte une date réelle proche d'aujourd'hui", () => {
    expect(dateSaisieRecevable("2026-10-17", NOW)).toBe(true);
    expect(dateSaisieRecevable("2028-02-29", NOW)).toBe(true); // bissextile
  });

  it("refuse une date qui n'existe pas, même bien formée", () => {
    expect(dateSaisieRecevable("2026-02-30", NOW)).toBe(false);
    expect(dateSaisieRecevable("2026-13-01", NOW)).toBe(false);
    expect(dateSaisieRecevable("2027-02-29", NOW)).toBe(false);
  });

  it("refuse ce qui n'est pas une chaîne au bon format", () => {
    for (const x of [undefined, null, 20261017, "2026-1-7", "17/10/2026", "2026-10-17T12:00"]) {
      expect(dateSaisieRecevable(x, NOW)).toBe(false);
    }
  });

  it(`borne à ±${DATE_SAISIE_MAX_ANS} ans autour d'aujourd'hui`, () => {
    expect(dateSaisieRecevable("2024-10-18", NOW)).toBe(true);
    expect(dateSaisieRecevable("2028-10-16", NOW)).toBe(true);
    expect(dateSaisieRecevable("2024-10-01", NOW)).toBe(false);
    expect(dateSaisieRecevable("2028-11-01", NOW)).toBe(false);
    expect(dateSaisieRecevable("2062-10-17", NOW)).toBe(false); // « 2062 » pour « 2026 »
  });
});
