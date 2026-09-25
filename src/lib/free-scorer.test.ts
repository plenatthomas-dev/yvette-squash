import { describe, it, expect } from "vitest";
import {
  cleanName,
  HISTORY_TTL_DAYS,
  MAX_HISTORY,
  parseMatch,
  pruneHistory,
  pushHistory,
  resultLine,
  type FreeMatch,
} from "./free-scorer";
import type { ScoreEvent, Side } from "./interclub";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 18);

/** Un jeu gagné 11-k par `w`, points alternés pour le perdant puis d'affilée. */
function game(w: Side, k: number): ScoreEvent[] {
  const l: Side = w === "home" ? "away" : "home";
  const out: ScoreEvent[] = [];
  for (let i = 0; i < k; i++) out.push({ t: "point", side: w }, { t: "point", side: l });
  for (let i = k; i < 11; i++) out.push({ t: "point", side: w });
  return out;
}

function match(over: Partial<FreeMatch> = {}): FreeMatch {
  return {
    id: "a",
    startedAt: NOW,
    home: { name: "Paul", color: null },
    away: { name: "Marc", color: "#1565c0" },
    bestOf: 3,
    events: [],
    ...over,
  };
}

describe("cleanName", () => {
  it("réduit les espaces, borne à 40 et retombe sur le repli si vide", () => {
    expect(cleanName("  Jean   Luc ", "J1")).toBe("Jean Luc");
    expect(cleanName("   ", "J1")).toBe("J1");
    expect(cleanName(42, "J1")).toBe("J1");
    expect(cleanName("x".repeat(60), "J1")).toHaveLength(40);
  });
});

describe("parseMatch — un stockage abîmé ramène à l'écran de départ, sans casser", () => {
  it("relit un match valide tel quel", () => {
    const m = match({ events: [{ t: "serve", side: "home", box: "right" }, { t: "point", side: "home" }] });
    expect(parseMatch(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it.each([
    ["null", null],
    ["pas d'id", { ...match(), id: "" }],
    ["format inconnu", { ...match(), bestOf: 4 }],
    ["nom vide", { ...match(), home: { name: " ", color: null } }],
    ["événement inconnu", { ...match(), events: [{ t: "let" }] }],
    ["carré inconnu", { ...match(), events: [{ t: "serve", side: "home", box: "milieu" }] }],
  ])("refuse : %s", (_label, raw) => {
    expect(parseMatch(raw)).toBeNull();
  });

  it("une couleur invalide devient « pas de couleur » plutôt qu'un refus", () => {
    const raw = { ...match(), home: { name: "Paul", color: "rouge vif" } };
    expect(parseMatch(raw)?.home.color).toBeNull();
  });
});

describe("historique local", () => {
  it(`garde les ${MAX_HISTORY} plus récents`, () => {
    const list = Array.from({ length: 15 }, (_, i) => match({ id: `m${i}`, startedAt: NOW - i * 1000 }));
    const out = pruneHistory(list, NOW);
    expect(out).toHaveLength(MAX_HISTORY);
    expect(out[0].id).toBe("m0");
  });

  it(`oublie ce qui a plus de ${HISTORY_TTL_DAYS} jours`, () => {
    const vieux = match({ id: "vieux", startedAt: NOW - (HISTORY_TTL_DAYS + 1) * DAY });
    expect(pruneHistory([vieux, match()], NOW).map((m) => m.id)).toEqual(["a"]);
  });

  it("ajoute en tête, sans doublon", () => {
    const a = match({ id: "a", startedAt: NOW - 1000 });
    const b = match({ id: "b", startedAt: NOW });
    const out = pushHistory([a, b], { ...a, events: game("home", 3) }, NOW);
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
    expect(out.find((m) => m.id === "a")?.events.length).toBeGreaterThan(0);
  });
});

describe("resultLine — le texte partagé", () => {
  it("écrit du point de vue du vainqueur, jeux compris", () => {
    const events: ScoreEvent[] = [
      { t: "serve", side: "home", box: "right" },
      ...game("away", 7),
      ...game("home", 9),
      ...game("away", 4),
    ];
    expect(resultLine(match({ events }))).toBe("Marc bat Paul 2-1 (11-7, 9-11, 11-4)");
  });

  it("dit « en cours » pour un match inachevé", () => {
    const events: ScoreEvent[] = [
      { t: "serve", side: "home", box: "right" },
      ...game("home", 5),
      { t: "point", side: "away" },
    ];
    expect(resultLine(match({ events }))).toBe("Paul 1-0 Marc (en cours, 0-1) — jeux : 11-5");
  });

  it("match pas commencé", () => {
    expect(resultLine(match())).toBe("Paul 0-0 Marc (en cours)");
  });
});
