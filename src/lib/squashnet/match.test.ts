import { describe, it, expect } from "vitest";
import { normalize, matchRanking, classifyRanking, searchQuery, YVETTE_CLUB } from "./match";
import type { RankingRow } from "./client";

// Fabrique une ligne minimale (les champs non testés ont des valeurs neutres).
function row(over: Partial<RankingRow> & { name: string; club: string }): RankingRow {
  return {
    clt: "5A",
    licence: "0000000",
    ligue: "IDF",
    cat: "Senior",
    gender: "male",
    rang: "0",
    rangM: "0",
    mean: "0",
    ...over,
  };
}

describe("normalize", () => {
  it("minuscule, sans accents, ponctuation → espace", () => {
    expect(normalize("Jérôme")).toBe("jerome");
    expect(normalize("Squash de l'Yvette")).toBe("squash de l yvette");
    expect(normalize("Jean-Luc  MARTIN")).toBe("jean luc martin");
  });
  it("le club squashnet (apostrophe déjà retirée) == la cible normalisée", () => {
    expect(normalize("Squash de l yvette")).toBe(normalize("Squash de l'Yvette"));
  });
});

describe("matchRanking", () => {
  const jerome = { givenName: "Jérôme", familyName: "Courtaut", gender: "male" };

  it("match simple dans le club, ordre NOM PRÉNOM + accents tolérés", () => {
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A", licence: "0124215" })];
    expect(matchRanking(jerome, rows)).toMatchObject({ clt: "5A", licence: "0124215" });
  });

  it("parse le rang national en entier (espaces retirés) ; non-numérique → null", () => {
    const withRang = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rang: "3 184" })];
    expect(matchRanking(jerome, withRang)?.rang).toBe(3184);
    const noRang = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rang: "NC" })];
    expect(matchRanking(jerome, noRang)?.rang).toBeNull();
  });

  it("parse AUSSI le rang mixte (rangM), distinct du rang dans le genre", () => {
    // Deux colonnes distinctes sur squashnet : `rang` situe le joueur DANS SON GENRE,
    // `rangM` est le rang MIXTE, toutes catégories — donc toujours >= `rang`. Valeurs
    // relevées en live sur la fiche de PLENAT THOMAS. C'est rangM qu'affiche l'annuaire,
    // d'où ce garde-fou contre une confusion des deux champs.
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rang: "2 219", rangM: "2 339" })];
    expect(matchRanking(jerome, rows)).toMatchObject({ rang: 2219, rangM: 2339 });
    const noRangM = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rangM: "" })];
    expect(matchRanking(jerome, noRangM)?.rangM).toBeNull();
  });

  it("refuse un rang non entier ou nul (« 0 » n'est pas un classement)", () => {
    // Un rang commence à 1 : « 0 » est une case vide déguisée. Le laisser passer le
    // placerait en tête du tri « Classement » de l'annuaire, devant les mieux classés.
    const zero = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rang: "0", rangM: "0" })];
    expect(matchRanking(jerome, zero)).toMatchObject({ rang: null, rangM: null });
    // Et on ne retient pas la partie numérique d'une valeur parasitée (parseInt le ferait).
    const dirty = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, rang: "3184e" })];
    expect(matchRanking(jerome, dirty)?.rang).toBeNull();
  });

  // La moyenne de points ne sert ni à l'annuaire ni à l'ordre des simples : elle n'existe que
  // pour la COURBE, dont elle est la seule valeur qui bouge tous les mois.
  it("lit la moyenne de points, espace de milliers comprise", () => {
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, mean: "3 832.17" })];
    expect(matchRanking(jerome, rows)?.mean).toBe(3832.17);
    // Espace insécable et fine insécable : c'est ce que rend un HTML français, et `parseFloat`
    // s'arrêterait au premier espace en rendant 3 — une valeur mille fois trop petite qui a
    // l'air d'un nombre, donc qui s'afficherait.
    const nbsp = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, mean: "3\u00a0832.17" })];
    expect(matchRanking(jerome, nbsp)?.mean).toBe(3832.17);
  });

  it("refuse une moyenne vide, nulle ou illisible plutôt que d'écraser la courbe", () => {
    for (const mean of ["", "0", "—", "3 832,17.5"]) {
      const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, mean })];
      expect(matchRanking(jerome, rows)?.mean).toBeNull();
    }
    // La virgule décimale est acceptée, au cas où la fédération francise son rendu.
    const fr = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, mean: "3 832,17" })];
    expect(matchRanking(jerome, fr)?.mean).toBe(3832.17);
  });

  it("ignore un homonyme dans un AUTRE club (filtre club)", () => {
    const rows = [
      row({ name: "COURTAUT JEROME", club: "Squash Club de Rennes", clt: "2C" }),
      row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A" }),
    ];
    expect(matchRanking(jerome, rows)?.clt).toBe("5A");
  });

  it("ambigu : deux homonymes DANS le club → null (on n'affirme rien)", () => {
    const rows = [
      row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A" }),
      row({ name: "COURTAUT JEROME", club: "Squash de l yvette", clt: "4B" }),
    ];
    expect(matchRanking(jerome, rows)).toBeNull();
  });

  it("exclut sur genre incompatible (les deux connus)", () => {
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, gender: "female" })];
    expect(matchRanking(jerome, rows)).toBeNull();
  });

  it("genre inconnu côté membre → n'exclut pas", () => {
    const sansGenre = { givenName: "Jérôme", familyName: "Courtaut" };
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, gender: "male" })];
    expect(matchRanking(sansGenre, rows)).not.toBeNull();
  });

  it("tolère un 2e prénom côté squashnet", () => {
    const rows = [row({ name: "COURTAUT JEAN JEROME", club: YVETTE_CLUB })];
    expect(matchRanking(jerome, rows)).not.toBeNull();
  });

  it("ne matche pas un préfixe de nom (courtaut ≠ court)", () => {
    const court = { givenName: "Marie", familyName: "Court" };
    const rows = [row({ name: "COURTAUT MARIE", club: YVETTE_CLUB })];
    expect(matchRanking(court, rows)).toBeNull();
  });

  it("nom de famille composé (tirets) matché indépendamment de l'ordre", () => {
    const m = { givenName: "Anne", familyName: "Dupont-Durand" };
    const rows = [row({ name: "DUPONT DURAND ANNE", club: YVETTE_CLUB, clt: "3B" })];
    expect(matchRanking(m, rows)?.clt).toBe("3B");
  });

  it("aucune ligne → null", () => {
    expect(matchRanking(jerome, [])).toBeNull();
  });
});

describe("classifyRanking", () => {
  const jerome = { givenName: "Jérôme", familyName: "Courtaut", gender: "male" };

  it("une seule ligne du club → matched (porte le classement)", () => {
    const rows = [row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A" })];
    const v = classifyRanking(jerome, rows);
    expect(v.status).toBe("matched");
    expect(v.status === "matched" && v.match.clt).toBe("5A");
  });

  it("nom retrouvé UNIQUEMENT hors du club → moved (absence fiable)", () => {
    const rows = [row({ name: "COURTAUT JEROME", club: "Squash Club de Rennes" })];
    expect(classifyRanking(jerome, rows).status).toBe("moved");
  });

  it("aucune ligne au nom (autres joueurs du même NOM) → unknown (pas d'absence sûre)", () => {
    // Homonymes de nom de famille, prénoms différents : le membre est peut-être en page 2.
    const rows = [
      row({ name: "COURTAUT PAUL", club: "Autre Club" }),
      row({ name: "COURTAUT MARIE", club: "Encore Autre" }),
    ];
    expect(classifyRanking(jerome, rows).status).toBe("unknown");
  });

  it("homonymes ambigus DANS le club → unknown (ni match ni suppression)", () => {
    const rows = [
      row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A" }),
      row({ name: "COURTAUT JEROME", club: "Squash de l yvette", clt: "4B" }),
    ];
    expect(classifyRanking(jerome, rows).status).toBe("unknown");
  });

  it("membre présent au club MALGRÉ des homonymes ailleurs → matched", () => {
    const rows = [
      row({ name: "COURTAUT JEROME", club: "Squash Club de Rennes", clt: "2C" }),
      row({ name: "COURTAUT JEROME", club: YVETTE_CLUB, clt: "5A" }),
    ];
    const v = classifyRanking(jerome, rows);
    expect(v.status === "matched" && v.match.clt).toBe("5A");
  });

  it("réponse vide → unknown (jamais moved)", () => {
    expect(classifyRanking(jerome, []).status).toBe("unknown");
  });
});

describe("searchQuery", () => {
  it("interroge squashnet par nom de famille", () => {
    expect(searchQuery({ givenName: "Jérôme", familyName: "Courtaut" })).toBe("Courtaut");
  });
});

describe("classifyRanking — hors club et licence (l'historique)", () => {
  const jean = { givenName: "Jean", familyName: "Dupont" };

  it("hors club : accepte l'unique ligne au nom, quel que soit le club", () => {
    const rows = [row({ name: "DUPONT JEAN", club: "Squash Club de Massy" })];
    expect(classifyRanking(jean, rows).status).toBe("moved");
    expect(classifyRanking(jean, rows, { horsClub: true }).status).toBe("matched");
  });

  it("hors club : NE REND JAMAIS `moved` — il n'y a plus de dehors à constater", () => {
    // C'est ce qui interdit d'utiliser ce mode pour le rafraîchissement mensuel, dont le
    // verdict `moved` sert à retirer le classement de qui a quitté le club.
    const rows = [row({ name: "DUPONT JEAN", club: "Squash Club de Massy" })];
    expect(classifyRanking(jean, rows, { horsClub: true }).status).not.toBe("moved");
  });

  it("hors club : deux homonymes restent `unknown`, jamais tirés au sort", () => {
    const rows = [
      row({ name: "DUPONT JEAN", club: "Squash Club de Massy", licence: "1" }),
      row({ name: "DUPONT JEAN", club: "Squash de Palaiseau", licence: "2" }),
    ];
    expect(classifyRanking(jean, rows, { horsClub: true }).status).toBe("unknown");
  });

  it("la licence prime sur tout : bon joueur, même chez les homonymes et hors du club", () => {
    const rows = [
      row({ name: "DUPONT JEAN", club: "Squash Club de Massy", licence: "42", rangM: "1800" }),
      row({ name: "DUPONT JEAN", club: "Squash de Palaiseau", licence: "99", rangM: "2500" }),
    ];
    const v = classifyRanking(jean, rows, { horsClub: true, licence: "42" });
    expect(v.status).toBe("matched");
    if (v.status === "matched") expect(v.match.rangM).toBe(1800);
  });

  it("une licence connue mais ABSENTE ne conclut rien : on retombe sur le nom", () => {
    // Elle peut manquer parce que le joueur n'était pas licencié ce mois-là, mais aussi parce
    // que la colonne est vide sur cette ligne — deux cas qu'on ne sait pas départager ici.
    const rows = [row({ name: "DUPONT JEAN", club: "Squash Club de Massy", licence: "99" })];
    expect(classifyRanking(jean, rows, { horsClub: true, licence: "42" }).status).toBe("matched");
  });

  it("la licence ne sert pas à contourner le filtre par club du passage MENSUEL", () => {
    // Sans `horsClub`, une licence trouvée ailleurs rapproche quand même — c'est voulu : elle
    // identifie la PERSONNE. Le mensuel ne la passe simplement pas (cf. `Subject.licence`).
    const rows = [row({ name: "DUPONT JEAN", club: "Squash Club de Massy", licence: "42" })];
    expect(classifyRanking(jean, rows).status).toBe("moved");
  });
});
