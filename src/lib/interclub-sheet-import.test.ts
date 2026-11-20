import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} }));
vi.mock("./interclub-gate", () => ({ interclubChanged: vi.fn(), todayISO: () => "2026-11-20" }));

import {
  lineImport,
  parseSheetScore,
  planCorrection,
  planSheetImport,
  porteLeResultat,
  type AppMatchState,
} from "./interclub-sheet-import";
import type { TieLine, TieSheet } from "./squashnet/tie";

const joueur = (name: string) => ({ name, regiid: null, clt: null, rang: null, rangM: null });

function ligne(over: Partial<TieLine> = {}): TieLine {
  return {
    label: "Homme 1",
    a: joueur("DUPONT JEAN"),
    b: joueur("MARTIN PAUL"),
    score: "11-6 11-3 8-11 11-0",
    winner: "A",
    gamesA: 3,
    gamesB: 1,
    pointsA: 41,
    pointsB: 20,
    ...over,
  };
}

function feuille(lines: TieLine[]): TieSheet {
  return {
    snTieId: "1",
    codeA: "VERR3",
    codeB: "YVET1",
    division: null,
    group: null,
    round: "J3",
    venue: null,
    date: "2026-11-19",
    time: null,
    lines,
    totals: null,
  };
}

describe("parseSheetScore", () => {
  it("lit le score côté A", () => {
    expect(parseSheetScore("11-6 8-11", "A")).toEqual([
      { home: 11, away: 6 },
      { home: 8, away: 11 },
    ]);
  });
  it("retourne le score quand nous sommes B", () => {
    expect(parseSheetScore("11-6 8-11", "B")).toEqual([
      { home: 6, away: 11 },
      { home: 11, away: 8 },
    ]);
  });
  it("refuse ce qui ne se lit pas", () => {
    expect(parseSheetScore("WO", "A")).toBeNull();
    expect(parseSheetScore("", "A")).toBeNull();
    expect(parseSheetScore(null, "A")).toBeNull();
  });
});

describe("lineImport", () => {
  it("importe un simple gagné, nous côté B", () => {
    const li = lineImport(ligne({ winner: "B", score: "6-11 3-11 11-8 0-11", gamesA: 1, gamesB: 3 }), 2, "B", 5);
    expect(li).toMatchObject({
      order: 2,
      ourName: "MARTIN PAUL",
      awayName: "Dupont Jean",
      gamesHome: 3,
      gamesAway: 1,
      winner: "home",
      outcome: null,
    });
    expect(li?.games).toHaveLength(4);
  });
  it("se replie sur le total quand le score est illisible (forfait)", () => {
    const li = lineImport(ligne({ score: "WO", b: null, gamesA: 3, gamesB: 0 }), 1, "A", 5);
    expect(li).toMatchObject({ games: [], gamesHome: 3, gamesAway: 0, winner: "home", outcome: "forfait", awayName: null });
  });
  it("ignore une ligne non tranchée", () => {
    expect(lineImport(ligne({ winner: null }), 1, "A", 5)).toBeNull();
  });
});

describe("planSheetImport", () => {
  const target = { bestOf: 5, matches: [1, 2, 3, 4].map((order) => ({ order, status: "pending" })) };

  it("rien sans notre côté, ni sur une feuille incomplète", () => {
    const f = feuille([ligne(), ligne()]);
    expect(planSheetImport(f, null, target)).toBeNull();
    expect(planSheetImport(feuille([ligne(), ligne({ winner: null })]), "A", target)).toBeNull();
  });

  it("importe tous les simples d'une feuille complète", () => {
    const plan = planSheetImport(feuille([ligne(), ligne(), ligne(), ligne()]), "A", target);
    expect(plan?.map((l) => l.order)).toEqual([1, 2, 3, 4]);
  });

  it("ne touche jamais un simple déjà terminé dans l'appli", () => {
    const t = { ...target, matches: target.matches.map((m) => (m.order === 2 ? { ...m, status: "done" } : m)) };
    const plan = planSheetImport(feuille([ligne(), ligne(), ligne(), ligne()]), "A", t);
    expect(plan?.map((l) => l.order)).toEqual([1, 3, 4]);
  });
});

describe("planCorrection — score corrigé après coup", () => {
  // Rencontre déjà importée : le simple 1 porte 3-1 (11-6 11-3 8-11 11-0), côté A.
  const ancienne = feuille([ligne(), ligne({ score: "11-1 11-2 11-3", gamesA: 3, gamesB: 0 })]);
  const importe = (order: number, l: TieLine): AppMatchState => {
    const li = lineImport(l, order, "A", 5)!;
    return { id: `m${order}`, order, status: "done", gamesHome: li.gamesHome, gamesAway: li.gamesAway, outcome: li.outcome, games: li.games };
  };
  const matches = [importe(1, ancienne.lines[0]), importe(2, ancienne.lines[1])];
  // La ligue corrige le simple 1 : 3-2 au lieu de 3-1.
  const corrigee = feuille([
    ligne({ score: "11-6 11-3 8-11 9-11 11-5", gamesA: 3, gamesB: 2 }),
    ancienne.lines[1],
  ]);

  it("met à jour le seul simple qui a changé", () => {
    const plan = planCorrection(ancienne, "A", corrigee, "A", 5, matches);
    expect(plan.map((p) => p.matchId)).toEqual(["m1"]);
    expect(plan[0].li).toMatchObject({ gamesHome: 3, gamesAway: 2 });
    expect(plan[0].li.games).toHaveLength(5);
  });

  it("n'écrase JAMAIS un simple corrigé à la main dans l'appli", () => {
    const aLaMain = [{ ...matches[0], gamesAway: 0, games: matches[0].games.slice(0, 3) }, matches[1]];
    expect(planCorrection(ancienne, "A", corrigee, "A", 5, aLaMain)).toEqual([]);
  });

  it("suit un changement de joueur, même à score égal (officielle à la place d'une reconstituée)", () => {
    const echange = feuille([ligne({ a: joueur("AUTRE NOM") }), ancienne.lines[1]]);
    const plan = planCorrection(ancienne, "A", echange, "A", 5, matches);
    expect(plan).toHaveLength(1);
    expect(plan[0].li.ourName).toBe("AUTRE NOM");
  });

  it("rien si une feuille est incomplète ou sans notre côté", () => {
    expect(planCorrection(ancienne, null, corrigee, "A", 5, matches)).toEqual([]);
    expect(planCorrection(ancienne, "A", feuille([ligne({ winner: null })]), "A", 5, matches)).toEqual([]);
  });

  it("porteLeResultat : un simple pas terminé ne porte rien", () => {
    const li = lineImport(ancienne.lines[0], 1, "A", 5)!;
    expect(porteLeResultat(matches[0], li)).toBe(true);
    expect(porteLeResultat({ ...matches[0], status: "live" }, li)).toBe(false);
  });
});
