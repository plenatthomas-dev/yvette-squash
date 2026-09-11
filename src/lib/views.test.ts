import { describe, it, expect } from "vitest";
import { VIEWS, isSpecialView, isView, viewAtStartup, type View } from "./views";

// ============================================================================
//  « JE RAFRAÎCHIS ET JE REPARS SUR LES CRÉNEAUX. »
//
//  Deux fois le même défaut, deux vues différentes : le Fil, puis l'écran
//  Capitaine. À chaque fois, la vue s'écrivait correctement dans l'URL ET dans
//  localStorage, puis était refusée à la relecture parce qu'un garde-fou
//  recopiait l'union des vues au lieu de l'interroger. Aucune erreur, aucun
//  message : la vue revenait simplement sur « day ».
//
//  Le test qui compte est le premier : il est écrit sur `VIEWS`, donc une vue
//  ajoutée demain y entre toute seule. C'est le seul moyen d'empêcher une
//  troisième fois.
// ============================================================================

describe("viewAtStartup — toute vue survit à un rafraîchissement", () => {
  // ⚠️ ÉCRIT SUR LA LISTE, PAS SUR UNE COPIE. Une vue ajoutée à `VIEWS` est testée d'office ;
  // énumérer les vues ici referait exactement l'erreur qu'on corrige.
  const rouvrables = VIEWS.filter((v) => v !== "week");

  it.each(rouvrables)("rouvre « %s » depuis l'URL", (v) => {
    expect(viewAtStartup(v, null)).toBe(v);
  });

  it.each(rouvrables)("rouvre « %s » depuis localStorage", (v) => {
    expect(viewAtStartup(null, v)).toBe(v);
  });

  it("l'URL prime sur localStorage — un lien partagé ouvre ce qu'il désigne", () => {
    // Sinon le destinataire d'un lien atterrirait sur ce qu'IL regardait la dernière fois.
    expect(viewAtStartup("interclub", "money")).toBe("interclub");
  });

  it("n'ouvre JAMAIS la Semaine au lancement — la seule exception, et elle est mesurée", () => {
    // `/api/week` fait sept appels à ResaMania : la poser sur le chemin critique du démarrage
    // ferait attendre quelqu'un qui voulait juste voir sa journée. Elle reste à un clic.
    expect(viewAtStartup("week", null)).toBeNull();
    expect(viewAtStartup(null, "week")).toBeNull();
  });

  it("garde le défaut sur une valeur inconnue, vide ou absente", () => {
    // Une vue retirée du code, une URL bricolée, un localStorage d'une version antérieure.
    expect(viewAtStartup("trombinoscope", null)).toBeNull();
    expect(viewAtStartup(null, null)).toBeNull();
    expect(viewAtStartup("", "")).toBeNull();
  });

  it("ne se laisse pas berner par la casse — « Day » n'est pas une vue", () => {
    // La valeur écrite par l'appli est toujours en minuscules : accepter autre chose
    // reviendrait à deviner ce qu'un tiers a mis dans l'URL.
    expect(viewAtStartup("Captain", null)).toBeNull();
  });
});

describe("isView", () => {
  it("reconnaît toutes les vues, et rien d'autre", () => {
    for (const v of VIEWS) expect(isView(v)).toBe(true);
    expect(isView("admin")).toBe(false);
    expect(isView(null)).toBe(false);
    expect(isView(undefined)).toBe(false);
  });
});

describe("isSpecialView", () => {
  it("le planning garde son chrome, tout le reste est plein écran", () => {
    expect(isSpecialView("day")).toBe(false);
    expect(isSpecialView("week")).toBe(false);
    for (const v of VIEWS.filter((x) => x !== "day" && x !== "week")) {
      expect(isSpecialView(v as View)).toBe(true);
    }
  });
});
