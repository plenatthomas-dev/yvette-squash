import { describe, it, expect } from "vitest";
import { fitText, scoreFileName } from "./score-image";
import type { FreeMatch } from "./free-scorer";

// Mesure factice : 10 px par caractère. Assez pour éprouver la troncature sans canvas.
const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) as TextMetrics };

describe("fitText — un nom trop long ne déborde pas de l'image", () => {
  it("laisse intact ce qui tient", () => {
    expect(fitText(ctx, "Paul", 100)).toBe("Paul");
  });
  it("tronque avec une ellipse, sans dépasser la largeur", () => {
    const out = fitText(ctx, "Jean-Christophe Delamotte", 100);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length * 10).toBeLessThanOrEqual(100);
  });
});

describe("scoreFileName", () => {
  it("donne un nom de fichier lisible, sans accents ni espaces", () => {
    const m: FreeMatch = {
      id: "a",
      startedAt: new Date(2026, 8, 25, 20).getTime(),
      home: { name: "Gérard Lâm", color: null },
      away: { name: "Zoé", color: null },
      bestOf: 3,
      events: [],
    };
    expect(scoreFileName(m)).toBe("score-gerard-lam-zoe-2026-09-25.png");
  });
});
