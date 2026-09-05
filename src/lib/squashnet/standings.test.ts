import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStandings } from "./standings";

// ============================================================================
//  LE VRAI CLASSEMENT DE LA POULE — critérium 2025-2026, Hommes 4, poule IVD.
//
//  Fragment capté tel quel sur squashnet (`ic_a=394242`, eventid + drawid 47760
//  + roundid 370138). On y fige les six équipes, leurs points et leurs averages
//  — les chiffres exacts sur lesquels se joue une montée.
// ============================================================================

const html = readFileSync(
  join(__dirname, "__fixtures__", "classement-2026-yvette-poule-ivd.html"),
  "utf8",
);

describe("parseStandings — le classement réel de la poule IVD", () => {
  const rows = parseStandings(html);

  it("lit les six équipes de la poule, dans l'ordre publié", () => {
    expect(rows.map((r) => r.name)).toEqual([
      "Liberty Country Club 3",
      "Squash de l'Yvette",
      "Chaville 4",
      "Verrieres 3",
      "UCPA Meudon 2",
      "Liberty Country Club 2",
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("porte notre ligne avec son identifiant fédéral, et pas seulement son nom", () => {
    // C'est `snTeamId` qui dira « c'est nous » à l'écran. Se fier au nom casserait le jour
    // où la ligue écrit « Squash de l'Yvette 1 », ou sur une poule à deux équipes du club.
    const nous = rows.find((r) => r.snTeamId === "161092");
    expect(nous?.name).toBe("Squash de l'Yvette");
    expect(nous?.code).toBe("YVETTE");
    expect(nous?.rank).toBe(2);
  });

  it("lit le détail complet d'une ligne : points, bilan, et les trois averages", () => {
    const nous = rows[1];
    expect(nous).toMatchObject({
      points: 9,
      played: 4,
      won: 3,
      drawWon: 0,
      drawLost: 0,
      lost: 1,
      penalties: 0,
    });
    expect(nous.matches).toEqual({ won: 11, lost: 4, diff: 7 });
    expect(nous.games).toEqual({ won: 39, lost: 19, diff: 20 });
    expect(nous.rallies).toEqual({ won: 559, lost: 436, diff: 123 });
  });

  it("AUCUN nul dans cette poule — elle se jouait encore en cinq simples", () => {
    // La preuve, dans les chiffres de la fédération, que le 2-2 n'existait pas en division 4
    // avant le passage à quatre simples : `E+` et `E-` sont à zéro pour les six équipes.
    expect(rows.every((r) => r.drawWon === 0 && r.drawLost === 0)).toBe(true);
    // Et le barème se vérifie sur les quatre équipes sans histoire : 3 points par victoire,
    // rien d'autre à distribuer puisqu'il n'y a aucun nul à départager.
    for (const r of rows.slice(0, 4)) {
      expect(r.points).toBe(r.won * 3);
    }
    // Les deux dernières s'en écartent — la ligue leur a retiré des points sans que la
    // colonne « P » en porte la trace. On lit ce que la fédération publie, on ne le
    // recalcule pas : c'est exactement pourquoi `points` vient du tableau et non d'un produit.
    expect(rows[4].points).toBeLessThan(rows[4].won * 3);
    expect(rows[5].points).toBeLessThan(rows[5].won * 3);
  });

  it("accepte un total NÉGATIF — une pénalité peut passer sous zéro", () => {
    // Liberty Country Club 2 finit à -3 : une victoire vaut 3 points, et la ligue en a retiré
    // davantage. Un parseur qui jetterait le signe afficherait +3 et un classement faux.
    const dernier = rows[5];
    expect(dernier.name).toBe("Liberty Country Club 2");
    expect(dernier.points).toBe(-3);
    expect(dernier.won).toBe(1);
  });

  it("écarte l'équipe fictive « Non Joue » des poules impaires", () => {
    expect(rows.some((r) => /non\s*jou/i.test(r.name))).toBe(false);
  });
});

describe("parseStandings — ce qu'il refuse de deviner", () => {
  it("rend une liste vide quand il n'y a pas de tableau", () => {
    expect(parseStandings("<div>Classement non publié</div>")).toEqual([]);
  });

  it("saute un tableau qui n'est PAS le classement, au lieu de le lire", () => {
    // On prenait le premier `<table>` venu, en affirmant que les rencontres « suivent dans le
    // même fragment ». La fixture n'en contient qu'un seul : l'affirmation n'était appuyée par
    // rien. Une légende ou un encart intercalé AU-DESSUS aurait rendu un classement faux sans
    // la moindre erreur — et un classement faux, ça s'affiche.
    const legende = `<table><tr><td>Pts</td><td>points de classement</td></tr>
      <tr><td>E+</td><td>nul gagné à l'average</td></tr></table>`;
    expect(parseStandings(legende + html).map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rend une liste vide quand AUCUN tableau n'est un classement", () => {
    // Le revers : ne pas se rabattre sur n'importe quel tableau faute de mieux. Zéro ligne dit
    // « je n'ai pas trouvé » ; six lignes tirées d'une légende diraient une contrevérité.
    expect(parseStandings("<table><tr><td>Règlement</td></tr></table>")).toEqual([]);
  });

  it("s'accroche aux data-label, PAS à l'ordre des colonnes", () => {
    // Dix-huit colonnes dans un ordre que rien ne garantit : une colonne insérée en tête
    // décalerait tout un parsing positionnel sans rien casser de visible — on lirait les jeux
    // à la place des matchs, et le tableau resterait crédible. Ici, l'ordre est inversé et
    // le résultat ne bouge pas d'un chiffre.
    const table = `<table><tr>
      <td data-label="P+-">300</td><td data-label="P-">1470</td><td data-label="P+">1770</td>
      <td data-label="J+-">59</td><td data-label="J-">63</td><td data-label="J+">122</td>
      <td data-label="M+-">22</td><td data-label="M-">17</td><td data-label="M+">39</td>
      <td data-label="P">0</td><td data-label="D">0</td><td data-label="E-">1</td>
      <td data-label="E+">3</td><td data-label="V">10</td><td data-label="J">14</td>
      <td data-label="Pts">37</td>
      <td data-label="Equipe"><a data-teamid="161037">Squash Pyramides 1 (PYRAM1)</a></td>
      <td data-label="#">1</td>
    </tr></table>`;
    expect(parseStandings(table)).toEqual([
      {
        rank: 1,
        name: "Squash Pyramides 1",
        code: "PYRAM1",
        snTeamId: "161037",
        points: 37,
        played: 14,
        won: 10,
        drawWon: 3,
        drawLost: 1,
        lost: 0,
        penalties: 0,
        matches: { won: 39, lost: 17, diff: 22 },
        games: { won: 122, lost: 63, diff: 59 },
        rallies: { won: 1770, lost: 1470, diff: 300 },
      },
    ]);
  });

  it("tolère les guillemets SIMPLES, comme le reste du module", () => {
    // squashnet a basculé tout son HTML des doubles aux simples le 2026-08-26 sans prévenir,
    // et le classement des joueurs avait cassé net ce jour-là.
    const table = `<table><tr>
      <td data-label='#'>1</td>
      <td data-label='Equipe'><a data-teamid='161092'>Squash de l'Yvette (YVETTE)</a></td>
      <td data-label='Pts'>9</td>
    </tr></table>`;
    const [r] = parseStandings(table);
    expect(r).toMatchObject({ rank: 1, snTeamId: "161092", points: 9 });
  });

  it("ignore une ligne sans rang ni nom plutôt que d'inventer une équipe", () => {
    const table = `<table><tr><td data-label="Pts">12</td></tr></table>`;
    expect(parseStandings(table)).toEqual([]);
  });
});
