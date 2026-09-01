import { describe, it, expect } from "vitest";
import {
  classementPower,
  compareRosterOrder,
  KNOWN_CLASSEMENTS,
  lineupOrderConflict,
  parseClassementInput,
  type RankableRosterEntry,
} from "./interclub-order";

describe("classementPower", () => {
  it("classe 1I avant 1N avant les catégories numérotées avant NC", () => {
    const i1 = classementPower("1I")!;
    const n1 = classementPower("1N")!;
    const cat2 = classementPower("2D")!;
    const nc = classementPower("NC")!;
    expect(i1).toBeLessThan(n1);
    expect(n1).toBeLessThan(cat2);
    expect(cat2).toBeLessThan(nc);
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
    expect(classementPower("1N")).toBe(classementPower("1n"));
  });

  it("tolère les espaces et la casse", () => {
    expect(classementPower(" 5a ")).toBe(classementPower("5A"));
    expect(classementPower(" 1i ")).toBe(classementPower("1I"));
  });

  it("la 1ère série ne se décline PAS en lettres — seuls 1I et 1N existent", () => {
    expect(classementPower("1A")).toBeNull();
    expect(classementPower("1D")).toBeNull();
  });

  it("refuse toute série au-delà de 5 ou en-deçà de 2 (avec lettre) — la pyramide FFSquash s'arrête à 5D", () => {
    expect(classementPower("6A")).toBeNull();
    expect(classementPower("10B")).toBeNull();
    expect(classementPower("0A")).toBeNull();
  });

  it("refuse « N », « R1 », « R2 » — n'existent pas au règlement FFSquash (confusion possible avec une DIVISION d'interclub)", () => {
    expect(classementPower("N")).toBeNull();
    expect(classementPower("R1")).toBeNull();
    expect(classementPower("R2")).toBeNull();
  });

  it("refuse un format inconnu", () => {
    expect(classementPower("")).toBeNull();
    expect(classementPower("5")).toBeNull();
    expect(classementPower("A5")).toBeNull();
    expect(classementPower("5E")).toBeNull();
    expect(classementPower("R3")).toBeNull();
    expect(classementPower("quoi")).toBeNull();
  });
});

describe("KNOWN_CLASSEMENTS", () => {
  // La liste du sélecteur admin (`KNOWN_CLASSEMENTS`) et la fonction qui la VALIDE
  // (`classementPower`) sont deux endroits distincts qui doivent dire la même chose — sans quoi
  // le menu déroulant pourrait un jour proposer une valeur que le serveur refuserait, ou
  // l'inverse. Ce test échoue si l'une évolue sans l'autre.
  it("chaque entrée est reconnue par classementPower, et 19 valeurs exactement (1I, 1N, 2A..5D, NC)", () => {
    expect(KNOWN_CLASSEMENTS).toHaveLength(19);
    for (const clt of KNOWN_CLASSEMENTS) {
      expect(classementPower(clt)).not.toBeNull();
    }
  });

  it("est ordonnée strictement du plus FAIBLE au plus fort (NC en tête) — les corrections courantes en premier", () => {
    expect(KNOWN_CLASSEMENTS[0]).toBe("NC");
    expect(KNOWN_CLASSEMENTS[KNOWN_CLASSEMENTS.length - 1]).toBe("1I");
    const powers = KNOWN_CLASSEMENTS.map((c) => classementPower(c)!);
    for (let i = 1; i < powers.length; i++) {
      expect(powers[i]).toBeLessThan(powers[i - 1]);
    }
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

describe("compareRosterOrder", () => {
  // Ordre d'AFFICHAGE du sélecteur : le mieux classé en tête. Sans rapport avec
  // `lineupOrderConflict`, qui valide l'ordre des simples déjà désignés d'une rencontre.
  const p = (name: string, clt: string | null, rangM: number | null = null): RankableRosterEntry => ({
    name,
    clt,
    rangM,
  });

  it("classe par CLASSEMENT, le mieux classé en tête", () => {
    const albert = p("Albert", "4D");
    const benoit = p("Benoît", "5A");
    expect(compareRosterOrder(albert, benoit)).toBeLessThan(0);
    expect(compareRosterOrder(benoit, albert)).toBeGreaterThan(0);
  });

  it("à classement égal, départage par RANG MIXTE — le plus petit en tête", () => {
    const zoe = p("Zoé", "5A", 300);
    const albert = p("Albert", "5A", 120);
    expect(compareRosterOrder(albert, zoe)).toBeLessThan(0);
    expect(compareRosterOrder(zoe, albert)).toBeGreaterThan(0);
  });

  it("ne compare jamais un rang mixte connu à un rang inconnu — laisse l'alphabétique trancher", () => {
    const albert = p("Albert", "5A", 120);
    const zoe = p("Zoé", "5A", null);
    expect(compareRosterOrder(albert, zoe)).toBe(0);
    expect(compareRosterOrder(zoe, albert)).toBe(0);
  });

  it("un classement inconnu (ou mal formé) passe TOUJOURS après un classement reconnu, NC compris", () => {
    const nc = p("Zoé", "NC");
    const inconnu = p("Albert", null);
    expect(compareRosterOrder(nc, inconnu)).toBeLessThan(0);
    expect(compareRosterOrder(inconnu, nc)).toBeGreaterThan(0);
  });

  it("deux classements inconnus sont à égalité — l'alphabétique déjà reçu du serveur tranche", () => {
    expect(compareRosterOrder(p("Albert", null), p("Zoé", null))).toBe(0);
  });

  it("trie une liste complète du mieux classé au moins bien, alphabétique en dernier recours", () => {
    // Reçu du serveur DÉJÀ trié par nom (`teamRoster`) : comme `compareRosterOrder` ne
    // départage jamais deux ex æquo lui-même (renvoie 0), c'est ce tri stable d'entrée qui
    // fournit l'ordre alphabétique de repli — exactement le contrat du client réel
    // (`[...roster].sort(compareRosterOrder)` dans `Interclub.tsx`).
    const roster = [
      p("Albert", "5A", 120),
      p("Chloé", "4D"),
      p("Denis", null),
      p("Zoé", "5A", null),
    ];
    const sorted = [...roster].sort(compareRosterOrder);
    expect(sorted.map((r) => r.name)).toEqual(["Chloé", "Albert", "Zoé", "Denis"]);
  });
});
