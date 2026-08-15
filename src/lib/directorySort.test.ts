import { describe, it, expect } from "vitest";
import { byRank } from "./directorySort";
import type { DirectoryMember } from "./directoryCache";

// Fabrique un membre minimal. `rangM` = rang MIXTE (le classement de référence), `rang` = rang
// dans son genre — les deux sont explicites ici, précisément parce que les confondre est LE
// piège de ce module.
function m(
  name: string,
  ranks: { rangM?: number | null; rang?: number | null } = {},
): DirectoryMember {
  return { id: name, name, ...ranks };
}

describe("byRank (tri « par classement », partagé annuaire + têtes de série)", () => {
  it("met le rang mixte le plus PETIT en tête (le mieux classé d'abord)", () => {
    const sorted = [m("Thomas", { rangM: 2339 }), m("Xavier", { rangM: 2231 })].sort(byRank);
    expect(sorted.map((x) => x.name)).toEqual(["Xavier", "Thomas"]);
  });

  it("ne compare JAMAIS un rang de genre à un rang mixte : le rang mixte passe devant", () => {
    // Le cas qui a produit un vrai bug : `rangM >= rang` toujours, donc un repli naïf
    // (`rangM ?? rang`) donnait à Marie le nombre 44 et la propulsait tête de série n°1,
    // devant tout le club. Les deux barèmes vivent dans des paliers étanches.
    const marie = m("Marie", { rang: 44, rangM: null }); // 44e joueuse, non rapprochée en mixte
    const thomas = m("Thomas", { rangM: 2339 });
    expect([marie, thomas].sort(byRank).map((x) => x.name)).toEqual(["Thomas", "Marie"]);
    expect([thomas, marie].sort(byRank).map((x) => x.name)).toEqual(["Thomas", "Marie"]);
  });

  it("ordonne quand même entre eux ceux qui n'ont qu'un rang de genre", () => {
    // Palier 2 : on ne prétend pas les situer face au palier 1, mais entre eux le rang de
    // genre reste une information exploitable — c'est l'état de TOUT le club tant que la
    // colonne `rangM` n'a pas été remplie par un rafraîchissement des classements.
    const sorted = [m("Anna", { rang: 900 }), m("Bruno", { rang: 120 })].sort(byRank);
    expect(sorted.map((x) => x.name)).toEqual(["Bruno", "Anna"]);
  });

  it("rejette les membres sans aucun classement en fin de liste", () => {
    // `null` (rapproché mais rang illisible) et absent (jamais rapproché) sont traités pareil.
    const sorted = [m("Sans"), m("Nul", { rangM: null }), m("Classé", { rangM: 2339 })].sort(
      byRank,
    );
    expect(sorted[0].name).toBe("Classé");
    expect(
      sorted
        .slice(1)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["Nul", "Sans"]);
  });

  it("est stable : à rang égal ou sans rang, l'ordre alphabétique d'entrée est conservé", () => {
    // La liste arrive déjà triée par nom du serveur — c'est ce qui garantit un ordre lisible
    // entre ex æquo, sans second critère de tri à maintenir.
    const sorted = [
      m("Anna"),
      m("Bruno"),
      m("Carla", { rangM: 100 }),
      m("Dora", { rangM: 100 }),
    ].sort(byRank);
    expect(sorted.map((x) => x.name)).toEqual(["Carla", "Dora", "Anna", "Bruno"]);
  });
});
