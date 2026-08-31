import { describe, it, expect } from "vitest";
import { classementPower, lineupOrderConflict, parseClassementInput } from "./interclub-order";

describe("classementPower", () => {
  it("classe N avant R1 avant R2 avant les catégories numérotées avant NC", () => {
    const n = classementPower("N")!;
    const r1 = classementPower("R1")!;
    const r2 = classementPower("R2")!;
    const cat1 = classementPower("1D")!;
    const nc = classementPower("NC")!;
    expect(n).toBeLessThan(r1);
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(cat1);
    expect(cat1).toBeLessThan(nc);
  });

  it("le CHIFFRE domine TOUJOURS la lettre — 4D plus fort que 5A", () => {
    expect(classementPower("4D")!).toBeLessThan(classementPower("5A")!);
  });

  it("à chiffre égal, A est plus fort que D", () => {
    expect(classementPower("5A")!).toBeLessThan(classementPower("5D")!);
    expect(classementPower("5A")!).toBeLessThan(classementPower("5B")!);
    expect(classementPower("5B")!).toBeLessThan(classementPower("5C")!);
    expect(classementPower("5C")!).toBeLessThan(classementPower("5D")!);
  });

  it("deux classements identiques ont le même poids (interchangeables)", () => {
    expect(classementPower("5A")).toBe(classementPower("5a"));
    expect(classementPower("NC")).toBe(classementPower("nc"));
  });

  it("tolère les espaces et la casse", () => {
    expect(classementPower(" 5a ")).toBe(classementPower("5A"));
  });

  it("accepte un numéro à deux chiffres", () => {
    expect(classementPower("10B")).not.toBeNull();
    expect(classementPower("2C")!).toBeLessThan(classementPower("10B")!);
  });

  it("refuse un format inconnu", () => {
    expect(classementPower("")).toBeNull();
    expect(classementPower("5")).toBeNull();
    expect(classementPower("A5")).toBeNull();
    expect(classementPower("5E")).toBeNull();
    expect(classementPower("0A")).toBeNull();
    expect(classementPower("R3")).toBeNull();
    expect(classementPower("quoi")).toBeNull();
  });
});

describe("lineupOrderConflict", () => {
  it("accepte une composition vide", () => {
    expect(lineupOrderConflict([])).toBeNull();
  });

  it("accepte un ordre strictement décroissant en force", () => {
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "4D" },
      { order: 2, name: "Benoît", clt: "5A" },
      { order: 3, name: "Carla", clt: "5D" },
      { order: 4, name: "Denis", clt: "NC" },
    ]);
    expect(pb).toBeNull();
  });

  it("accepte des classements égaux dans n'importe quel ordre (interchangeables)", () => {
    expect(
      lineupOrderConflict([
        { order: 1, name: "Albert", clt: "5A" },
        { order: 2, name: "Benoît", clt: "5A" },
      ]),
    ).toBeNull();
    expect(
      lineupOrderConflict([
        { order: 1, name: "Albert", clt: "NC" },
        { order: 2, name: "Benoît", clt: "NC" },
      ]),
    ).toBeNull();
  });

  it("ignore les simples non consécutifs en numéro tant que l'ordre relatif est bon", () => {
    // Le simple 2 est « à désigner » et n'est donc pas dans la liste : 1 et 3 doivent quand
    // même respecter l'ordre entre eux.
    expect(
      lineupOrderConflict([
        { order: 1, name: "Albert", clt: "4D" },
        { order: 3, name: "Carla", clt: "5A" },
      ]),
    ).toBeNull();
  });

  it("refuse Benoît (4D) après Albert (5A) — l'exemple exact de la règle du club", () => {
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "5A" },
      { order: 2, name: "Benoît", clt: "4D" },
    ]);
    expect(pb).not.toBeNull();
    expect(pb).toContain("Benoît");
    expect(pb).toContain("Albert");
  });

  it("refuse même si le mieux classé n'est pas au numéro le plus proche", () => {
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "4D" },
      { order: 2, name: "Benoît", clt: "NC" },
      { order: 3, name: "Carla", clt: "3A" },
    ]);
    expect(pb).not.toBeNull();
    expect(pb).toContain("Carla");
  });

  it("refuse un classement inconnu (null) sur un simple désigné", () => {
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "5A" },
      { order: 2, name: "Mystère", clt: null },
    ]);
    expect(pb).toContain("Mystère");
    expect(pb).toContain("classement inconnu");
  });

  it("refuse un classement mal formé (correction admin fautive)", () => {
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "cinq A" },
      { order: 2, name: "Benoît", clt: "5A" },
    ]);
    expect(pb).toContain("classement inconnu");
  });

  it("signale le classement inconnu avant de comparer l'ordre", () => {
    // Même si l'ordre serait par ailleurs respecté, le trou d'information passe en premier.
    const pb = lineupOrderConflict([
      { order: 1, name: "Albert", clt: "NC" },
      { order: 2, name: "Mystère", clt: null },
    ]);
    expect(pb).toContain("classement inconnu");
  });

  it("un seul simple désigné n'a rien à comparer : son classement n'est pas exigé", () => {
    expect(lineupOrderConflict([{ order: 1, name: "Albert", clt: null }])).toBeNull();
    expect(lineupOrderConflict([{ order: 3, name: "Albert", clt: "n'importe quoi" }])).toBeNull();
  });
});

describe("parseClassementInput", () => {
  it("accepte un classement valide et le met en MAJUSCULES", () => {
    expect(parseClassementInput("5a")).toEqual({ ok: true, value: "5A" });
    expect(parseClassementInput(" nc ")).toEqual({ ok: true, value: "NC" });
  });

  it("chaîne vide, absente ou blanche = pas de classement, pas une erreur", () => {
    expect(parseClassementInput("")).toEqual({ ok: true, value: null });
    expect(parseClassementInput("   ")).toEqual({ ok: true, value: null });
    expect(parseClassementInput(null)).toEqual({ ok: true, value: null });
    expect(parseClassementInput(undefined)).toEqual({ ok: true, value: null });
  });

  it("refuse un format non reconnu", () => {
    expect(parseClassementInput("cinq A").ok).toBe(false);
    expect(parseClassementInput(42).ok).toBe(false);
  });
});
