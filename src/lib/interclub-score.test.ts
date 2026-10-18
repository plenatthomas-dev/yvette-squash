import { describe, it, expect } from "vitest";
import { inverserScore, jeuxDuScore, totauxDesScores } from "./interclub-score";

describe("jeuxDuScore", () => {
  it("lit chaque jeu", () => {
    expect(jeuxDuScore("11-4 12-14 11-9")).toEqual([
      [11, 4],
      [12, 14],
      [11, 9],
    ]);
  });

  it("refuse le tout si un jeu ne se lit pas", () => {
    expect(jeuxDuScore("11-4 WO")).toBeNull();
    expect(jeuxDuScore("")).toBeNull();
    expect(jeuxDuScore(null)).toBeNull();
  });
});

describe("inverserScore", () => {
  it("retourne chaque jeu", () => {
    // Le simple de Kadi tel que l'écrit la poule (receveur d'abord) et tel que l'écrit sa fiche.
    expect(inverserScore("5-11 8-11 15-13 7-11")).toBe("11-5 11-8 13-15 11-7");
  });

  it("rend tel quel un score qu'il ne sait pas lire", () => {
    expect(inverserScore("forfait")).toBe("forfait");
  });
});

describe("totauxDesScores — J1 VERR5 1-3 AQISSY, chiffres de Squash App", () => {
  const simples = [
    "11-4 12-14 11-9 3-11 9-11",
    "9-11 8-11 7-11",
    "5-11 8-11 15-13 7-11",
    "11-1 11-5 7-11 10-12 11-9",
  ];

  it("6–11 jeux et 155–166 points", () => {
    expect(totauxDesScores(simples)).toEqual({ jeux: [6, 11], points: [155, 166] });
  });

  it("ignore un simple non joué, mais se tait sur un simple illisible", () => {
    expect(totauxDesScores([...simples, null, ""])).toEqual({ jeux: [6, 11], points: [155, 166] });
    expect(totauxDesScores([...simples, "WO"])).toBeNull();
    expect(totauxDesScores([null, null])).toBeNull();
  });
});
