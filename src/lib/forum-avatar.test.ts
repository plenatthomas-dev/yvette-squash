import { describe, it, expect } from "vitest";
import { initiales } from "./forum-avatar";

describe("initiales", () => {
  it("prend la première lettre d'un prénom seul", () => {
    expect(initiales("Thomas")).toBe("T");
  });

  it("prend la première et la dernière d'un nom complet", () => {
    expect(initiales("Thomas Plenat")).toBe("TP");
    expect(initiales("Jean Pierre Martin")).toBe("JM");
  });

  // Le trait d'union ne sépare pas deux personnes : « JB » se lirait comme des initiales
  // d'état civil, alors qu'on cherche un repère visuel dans un fil.
  it("ne coupe pas sur un trait d'union", () => {
    expect(initiales("Jean-Baptiste")).toBe("J");
  });

  it("met en capitales", () => {
    expect(initiales("gégé")).toBe("G");
    expect(initiales("éric dupont")).toBe("ÉD");
  });

  // LA RAISON D'ÊTRE DE LA DÉCOUPE PAR POINTS DE CODE. Un emoji occupe deux unités UTF-16 :
  // `charAt(0)` en rendrait la moitié, un caractère invalide affiché en losange noir.
  it("ne casse pas un caractère hors BMP", () => {
    expect(initiales("🎾 Gégé")).toBe("🎾G");
    expect([...initiales("🎾")].length).toBe(1);
  });

  it("rend un point d'interrogation plutôt que rien sur un nom vide", () => {
    expect(initiales("")).toBe("?");
    expect(initiales("   ")).toBe("?");
  });

  it("ignore les espaces multiples", () => {
    expect(initiales("  Thomas   Plenat  ")).toBe("TP");
  });
});
