import { describe, it, expect } from "vitest";
import { normalize, matchRanking, searchQuery, YVETTE_CLUB } from "./match";
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

describe("searchQuery", () => {
  it("interroge squashnet par nom de famille", () => {
    expect(searchQuery({ givenName: "Jérôme", familyName: "Courtaut" })).toBe("Courtaut");
  });
});
