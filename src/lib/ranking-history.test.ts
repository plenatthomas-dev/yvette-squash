import { describe, it, expect } from "vitest";
import {
  abscisse,
  bandesClassement,
  bornesAvecMarches,
  bornesValeurs,
  chemin,
  couleurDe,
  dernierPoint,
  frontieresClassement,
  moisDansPlage,
  moisLabel,
  ordonnee,
  progression,
  valeurs,
  COULEURS,
  type Cadre,
  type HistorySeries,
} from "./ranking-history";

const CADRE: Cadre = { w: 100, h: 100, padL: 0, padR: 0, padT: 0, padB: 0 };

/**
 * Une série dont CHAQUE mesure porte son propre classement — ce que `serie` ne permet pas
 * (elle fige « 5A »), et ce dont les frontières ont besoin : elles se déduisent justement de
 * la rencontre entre un classement et une moyenne.
 */
function serieCltee(
  points: { month: string; clt: string; rangM: number | null }[],
  over: Partial<HistorySeries> = {},
): HistorySeries {
  return {
    id: "u1",
    kind: "member",
    name: "Jean Dupont",
    team: null,
    points: points.map((p) => ({
      month: p.month,
      clt: p.clt,
      rang: null,
      rangM: p.rangM,
      mean: null,
    })),
    ...over,
  };
}

function serie(
  points: { month: string; rangM?: number | null }[],
  over: Partial<HistorySeries> = {},
): HistorySeries {
  return {
    id: "u1",
    kind: "member",
    name: "Jean Dupont",
    team: null,
    points: points.map((p) => ({
      month: p.month,
      clt: "5A",
      rang: null,
      rangM: p.rangM ?? null,
      mean: null,
    })),
    ...over,
  };
}

describe("moisLabel", () => {
  it("abrège le mois et l'année", () => {
    expect(moisLabel("2026-07-07")).toBe("juil. 26");
    expect(moisLabel("2025-01-06")).toBe("janv. 25");
    expect(moisLabel("2026-12-01")).toBe("déc. 26");
  });

  // La valeur est une date SANS fuseau : la passer par `new Date()` la ramènerait à minuit UTC,
  // soit la veille pour un lecteur à l'ouest de Greenwich — et toute la courbe glisserait d'un
  // mois, une fois sur deux dans l'année.
  it("ne recule pas d'un mois sur un premier du mois", () => {
    expect(moisLabel("2026-07-01")).toBe("juil. 26");
    expect(moisLabel("2026-01-01")).toBe("janv. 26");
  });

  it("rend la valeur telle quelle si elle n'a pas la forme attendue", () => {
    expect(moisLabel("n'importe quoi")).toBe("n'importe quoi");
  });
});

describe("moisDansPlage", () => {
  const mois = ["2026-01-05", "2026-02-02", "2026-03-02"];
  it("borne des deux côtés, bornes comprises", () => {
    expect(moisDansPlage(mois, "2026-02-02", "2026-03-02")).toEqual(["2026-02-02", "2026-03-02"]);
  });
  it("une borne vide ne borne pas de ce côté", () => {
    expect(moisDansPlage(mois, "", "2026-02-02")).toEqual(["2026-01-05", "2026-02-02"]);
    expect(moisDansPlage(mois, "2026-02-02", "")).toEqual(["2026-02-02", "2026-03-02"]);
  });
});

describe("valeurs", () => {
  // L'alignement sur les mois affichés est ce qui rend deux joueurs comparables : sans lui,
  // celui qui a des trous verrait ses points s'étaler sur toute la largeur, à côté d'un
  // coéquipier mesuré tous les mois, et les deux courbes ne parleraient pas du même temps.
  it("aligne sur les mois demandés, `null` là où rien n'a été mesuré", () => {
    const s = serie([
      { month: "2026-01-05", rangM: 1000 },
      { month: "2026-03-02", rangM: 1200 },
    ]);
    expect(valeurs(s, ["2026-01-05", "2026-02-02", "2026-03-02"])).toEqual([
      1000,
      null,
      1200,
    ]);
  });
});

describe("bornesValeurs", () => {
  it("prend le min et le max de TOUTES les séries affichées", () => {
    const a = serie([{ month: "m1", rangM: 1000 }]);
    const b = serie([{ month: "m1", rangM: 1400 }], { id: "u2" });
    expect(bornesValeurs([a, b], ["m1"])).toEqual({ min: 1000, max: 1400 });
  });
  it("null quand rien n'est mesurable (aucune échelle possible)", () => {
    expect(bornesValeurs([serie([{ month: "m1", rangM: null }])], ["m1"])).toBeNull();
    expect(bornesValeurs([], ["m1"])).toBeNull();
  });
});

describe("ordonnee", () => {
  const bornes = { min: 100, max: 200 };

  // C'est LE point du module : sans cette inversion, le joueur le plus en forme du club aurait
  // la courbe qui plonge, sur un graphique par ailleurs parfaitement lisible.
  //
  it("la meilleure valeur est la PLUS PETITE, donc en haut", () => {
    expect(ordonnee(100, bornes, CADRE)).toBe(0);
    expect(ordonnee(200, bornes, CADRE)).toBe(100);
  });
  it("toutes les valeurs égales → une ligne au milieu, jamais un NaN", () => {
    const plat = { min: 150, max: 150 };
    expect(ordonnee(150, plat, CADRE)).toBe(50);
    expect(Number.isNaN(ordonnee(150, plat, CADRE))).toBe(false);
  });
  it("respecte les marges du cadre", () => {
    const c: Cadre = { w: 100, h: 100, padL: 10, padR: 5, padT: 20, padB: 10 };
    expect(ordonnee(100, bornes, c)).toBe(20); // padT — le meilleur rang
    expect(ordonnee(200, bornes, c)).toBe(90); // h - padB
  });
});

describe("abscisse", () => {
  it("étale les mois sur la largeur utile", () => {
    expect(abscisse(0, 3, CADRE)).toBe(0);
    expect(abscisse(1, 3, CADRE)).toBe(50);
    expect(abscisse(2, 3, CADRE)).toBe(100);
  });
  it("un mois seul se pose au milieu, pas collé à gauche", () => {
    expect(abscisse(0, 1, CADRE)).toBe(50);
  });
});

describe("chemin", () => {
  const bornes = { min: 0, max: 100 };

  it("relie les points connus", () => {
    // 0 est la MEILLEURE moyenne, donc en haut (y = 0) ; 100 la pire, donc en bas.
    expect(chemin([0, 50, 100], bornes, CADRE)).toBe("M0.0 0.0 L50.0 50.0 L100.0 100.0");
  });

  // Relier janvier à mars par-dessus février dessinerait une progression continue là où rien
  // n'a été observé : le trou se voit, c'est le but.
  it("COUPE le trait sur un mois non mesuré au lieu de l'enjamber", () => {
    const d = chemin([0, null, 100], bornes, CADRE);
    expect(d).toBe("M0.0 0.0 M100.0 100.0");
    expect(d).not.toContain("L");
  });

  it("rend une chaîne vide quand rien n'est mesuré (pas de `d` invalide)", () => {
    expect(chemin([null, null], bornes, CADRE)).toBe("");
  });
});

describe("progression", () => {
  const mois = ["m1", "m2"];

  // Sans ce changement de signe, la colonne « évolution » afficherait un moins devant la
  // meilleure saison du club : passer 2300e → 1800e est un gain de 500 places.
  it("DESCENDRE au classement est un progrès positif", () => {
    const s = serie([{ month: "m1", rangM: 2300 }, { month: "m2", rangM: 1800 }]);
    expect(progression(s, mois)).toBe(500);
  });

  it("null sur une seule mesure : « 0 » ferait croire à une stagnation observée", () => {
    expect(progression(serie([{ month: "m1", rangM: 1000 }]), mois)).toBeNull();
    expect(progression(serie([]), mois)).toBeNull();
  });

  it("compare la première et la dernière mesure CONNUES, trous ignorés", () => {
    const s = serie([
      { month: "m1", rangM: 1000 },
      { month: "m2", rangM: null },
      { month: "m3", rangM: 900 },
    ]);
    // 1000 → 900 : la moyenne baisse, donc le joueur progresse de 100.
    expect(progression(s, ["m1", "m2", "m3"])).toBe(100);
  });
});

describe("dernierPoint", () => {
  it("rend la dernière mesure DANS la plage, pas la dernière tout court", () => {
    const s = serie([
      { month: "m1", rangM: 1000 },
      { month: "m2", rangM: 1100 },
      { month: "m3", rangM: 1200 },
    ]);
    expect(dernierPoint(s, ["m1", "m2"])?.rangM).toBe(1100);
    expect(dernierPoint(s, [])).toBeNull();
  });
});

describe("palette", () => {
  it("boucle au-delà du dernier joueur au lieu de rendre `undefined`", () => {
    expect(couleurDe(0)).toBe(COULEURS[0]);
    expect(couleurDe(COULEURS.length)).toBe(COULEURS[0]);
  });
});

describe("frontieresClassement", () => {
  // ⚠️ LE SENS. 5A est plus FORT que 5B, donc ses moyennes sont plus BASSES (mesuré : 4B tient
  // entre 1496 et 1659, 5D entre 7240 et 9052). Les fixtures de ce bloc ont d'abord été écrites
  // à l'envers, et la fonction ne traçait alors AUCUNE ligne — chaque paire échouait à son test
  // d'encadrement, en silence.
  it("pose la ligne ENTRE la plus basse moyenne du bas et la plus haute du haut", () => {
    const f = frontieresClassement(
      [
        serieCltee([
          { month: "m1", clt: "5B", rangM: 1400 },
          { month: "m2", clt: "5B", rangM: 1200 },
          { month: "m3", clt: "5A", rangM: 1000 },
          { month: "m4", clt: "5A", rangM: 900 },
        ]),
      ],
    );
    // Étiquetée par le classement qu'on ATTEINT en progressant, et posée au milieu de [1000, 1200].
    expect(f).toEqual([{ clt: "5A", valeur: 1100 }]);
  });

  // ⚠️ REVIREMENT ASSUMÉ. Cette fonction a d'abord refusé net de tracer sur le rang, au motif
  // qu'« un classement ne correspond à aucun rang fixe ». Le raisonnement supposait `mean` et
  // `rangM` indépendants — ils sont la même grandeur (r = 1,000). Une frontière est donc aussi
  // stable dans une échelle que dans l'autre, et c'est le test de chevauchement qui tranche.
  it("travaille dans l'échelle du rang, la seule que l'écran trace", () => {
    const s = serieCltee([
      { month: "m1", clt: "5B", rangM: 2400 },
      { month: "m2", clt: "5B", rangM: 2300 },
      { month: "m3", clt: "5A", rangM: 1900 },
    ]);
    expect(frontieresClassement([s])).toEqual([{ clt: "5A", valeur: 2100 }]);
  });

  it("ignore les mesures sans rang plutôt que de les compter pour zéro", () => {
    const s = serieCltee([
      { month: "m1", clt: "5B", rangM: null },
      { month: "m2", clt: "5B", rangM: 1100 },
      { month: "m3", clt: "5A", rangM: 900 },
    ]);
    expect(frontieresClassement([s])).toEqual([{ clt: "5A", valeur: 1000 }]);
  });

  it("saute une frontière quand les deux catégories se CHEVAUCHENT", () => {
    // Une moyenne vue sous 5A (1100) AU-DESSUS d'une moyenne vue sous 5B (1000) : le corpus se
    // contredit, donc on ne tranche pas plutôt que d'inventer un seuil au milieu du désordre.
    const s = serieCltee([
      { month: "m1", clt: "5B", rangM: 1400 },
      { month: "m2", clt: "5B", rangM: 1000 },
      { month: "m3", clt: "5A", rangM: 1100 },
      { month: "m4", clt: "5A", rangM: 800 },
    ]);
    expect(frontieresClassement([s])).toEqual([]);
  });

  it("saute une marche qui recouvre DEUX passages (échelons non adjacents)", () => {
    // 5C puis 5A : la marche entre les deux contient aussi le passage 5C→5B. L'étiqueter « 5A »
    // ferait lire un seuil unique là où il y en a deux.
    const s = serieCltee([
      { month: "m1", clt: "5C", rangM: 1200 },
      { month: "m2", clt: "5A", rangM: 600 },
    ]);
    expect(frontieresClassement([s])).toEqual([]);
  });

  it("écarte NC — absence d'échelon, que la fédération n'ordonne pas", () => {
    const s = serieCltee([
      { month: "m1", clt: "NC", rangM: 9000 },
      { month: "m2", clt: "5D", rangM: 7000 },
    ]);
    expect(frontieresClassement([s])).toEqual([]);
  });

  it("ignore un classement que la fédération n'a pas, sans casser les autres", () => {
    const s = serieCltee([
      { month: "m1", clt: "6Z", rangM: 10 },
      { month: "m2", clt: "5B", rangM: 1100 },
      { month: "m3", clt: "5A", rangM: 900 },
    ]);
    expect(frontieresClassement([s])).toEqual([{ clt: "5A", valeur: 1000 }]);
  });

  it("rend plusieurs marches, du plus faible au plus fort, et à travers les séries", () => {
    const f = frontieresClassement(
      [
        serieCltee([
          { month: "m1", clt: "5C", rangM: 1300 },
          { month: "m2", clt: "5B", rangM: 900 },
        ]),
        serieCltee([{ month: "m2", clt: "5A", rangM: 500 }], { id: "u2" }),
      ],
    );
    expect(f).toEqual([
      { clt: "5B", valeur: 1100 },
      { clt: "5A", valeur: 700 },
    ]);
  });

  it("ignore les mesures sans moyenne plutôt que de les compter pour zéro", () => {
    const s = serieCltee([
      { month: "m1", clt: "5B", rangM: null },
      { month: "m2", clt: "5B", rangM: 1100 },
      { month: "m3", clt: "5A", rangM: 900 },
    ]);
    expect(frontieresClassement([s])).toEqual([{ clt: "5A", valeur: 1000 }]);
  });

  it("ne rend rien quand une seule catégorie a été observée", () => {
    const s = serieCltee([
      { month: "m1", clt: "5A", rangM: 1100 },
      { month: "m2", clt: "5A", rangM: 1300 },
    ]);
    expect(frontieresClassement([s])).toEqual([]);
  });
});

describe("bornesAvecMarches", () => {
  // Sans cet élargissement, l'écran s'ouvrant sur UN joueur cadre sur les quelques dizaines de
  // points qu'il a parcourus : aucune frontière n'y tombe tant qu'il n'a pas changé de
  // classement, donc aucune ligne dans la vue par défaut — le défaut qui a fait remonter que
  // « les lignes ne s'affichent pas ».
  it("fait entrer une marche PROCHE, en élargissant du seul côté utile", () => {
    const b = { min: 1000, max: 1100 }; // étendue 100, marge tolérée 25
    expect(bornesAvecMarches(b, [{ clt: "5A", valeur: 980 }])).toEqual({ min: 980, max: 1100 });
    expect(bornesAvecMarches(b, [{ clt: "5B", valeur: 1120 }])).toEqual({ min: 1000, max: 1120 });
  });

  it("laisse dehors une marche LOINTAINE, plutôt que d'aplatir la courbe", () => {
    // 900 est à 100 sous le minimum, soit toute l'étendue : l'y faire entrer doublerait
    // l'échelle et le joueur deviendrait un trait plat, pour un repère hors de sa portée.
    const b = { min: 1000, max: 1100 };
    expect(bornesAvecMarches(b, [{ clt: "5A", valeur: 900 }])).toEqual(b);
  });

  it("prend la marche la plus éloignée parmi celles qui restent à portée", () => {
    const b = { min: 1000, max: 1100 };
    const out = bornesAvecMarches(b, [
      { clt: "5A", valeur: 990 },
      { clt: "4D", valeur: 978 },
      { clt: "4C", valeur: 800 }, // hors de portée, ignorée
    ]);
    expect(out).toEqual({ min: 978, max: 1100 });
  });

  it("ne touche à rien quand une marche est DÉJÀ dans le cadre", () => {
    const b = { min: 1000, max: 1100 };
    expect(bornesAvecMarches(b, [{ clt: "5A", valeur: 1050 }])).toEqual(b);
  });

  it("n'élargit pas une étendue nulle : un quart de zéro ne fait entrer personne", () => {
    // Cas courant (un joueur, une seule mesure), et l'écran a un état dédié pour lui. Élargir
    // ici ne ferait qu'inventer un cadre autour d'un point unique.
    const plat = { min: 1000, max: 1000 };
    expect(bornesAvecMarches(plat, [{ clt: "5A", valeur: 995 }])).toEqual(plat);
  });

  it("sans aucune marche, rend l'échelle telle quelle", () => {
    const b = { min: 1000, max: 1100 };
    expect(bornesAvecMarches(b, [])).toEqual(b);
  });
});

describe("bandesClassement", () => {
  const bornes = { min: 1000, max: 2000 };

  it("nomme chaque zone, borne aux frontières, et va jusqu'aux bords du cadre", () => {
    const b = bandesClassement(
      [
        { clt: "4D", valeur: 1300 },
        { clt: "5A", valeur: 1700 },
      ],
      bornes,
    );
    expect(b.map((z) => [z.clt, z.min, z.max])).toEqual([
      // Au-dessus de la meilleure frontière : on EST dans le classement qu'elle nomme.
      ["4D", 1000, 1300],
      ["5A", 1300, 1700],
      // Sous la dernière : l'échelon d'un cran plus faible que celui qu'elle fait atteindre.
      ["5B", 1700, 2000],
    ]);
  });

  it("ordonne la rampe du plus FAIBLE (0) au plus fort, pour doser la teinte", () => {
    const b = bandesClassement(
      [
        { clt: "4D", valeur: 1300 },
        { clt: "5A", valeur: 1700 },
      ],
      bornes,
    );
    expect(b.map((z) => [z.clt, z.rang])).toEqual([
      ["4D", 2],
      ["5A", 1],
      ["5B", 0],
    ]);
    expect(b.every((z) => z.total === 3)).toBe(true);
  });

  it("ignore une frontière HORS du cadre : elle ne borne aucune zone visible", () => {
    expect(bandesClassement([{ clt: "5A", valeur: 3000 }], bornes)).toEqual([]);
    expect(bandesClassement([], bornes)).toEqual([]);
  });

  it("se tait sous « 5D » plutôt que d'inventer un échelon en dessous", () => {
    // NC n'est pas un échelon de la pyramide : la bande du bas n'a pas de nom, donc pas de bande.
    const b = bandesClassement([{ clt: "5D", valeur: 1500 }], bornes);
    expect(b.map((z) => z.clt)).toEqual(["5D"]);
  });
});
