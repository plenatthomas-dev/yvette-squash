import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTieSheet, TieUnreadableError } from "./tie";

// ============================================================================
//  LA FEUILLE DE MATCH OFFICIELLE D'UNE VRAIE RENCONTRE.
//
//  Verrieres 2 – Verrieres 3, J1 du critérium 2025-2026, Hommes 4, poule A.
//  Fragment capté tel quel sur squashnet (`ic_a=394248`, tieid 1643001).
//
//  C'est le document contre lequel notre propre relevé se confronte : si la
//  ligue publie 4-1 et que notre feuille dit 3-2, l'un des deux est faux, et
//  c'est le capitaine qui doit l'apprendre — pas le classement de fin de saison.
// ============================================================================

const html = readFileSync(
  join(__dirname, "__fixtures__", "rencontre-2026-1643001-feuille.html"),
  "utf8",
);

describe("parseTieSheet — la feuille réelle de Verrieres 2 – Verrieres 3", () => {
  const feuille = parseTieSheet(html, "1643001");

  it("lit les CINQ simples, et pas la ligne de total", () => {
    // ⚠️ LE PIÈGE. La ligne « Total » a la même forme qu'un simple : même colonnes, même
    // chiffres. La prendre pour un match ajouterait un sixième simple, sans joueurs, que
    // l'écran afficherait comme « non saisi » sur une rencontre pourtant complète.
    expect(feuille.lines.map((l) => l.label)).toEqual([
      "Homme 1",
      "Homme 2",
      "Homme 3",
      "Homme 4",
      "Homme 5",
    ]);
  });

  it("⚠️ nomme les deux côtés par leur SIGLE, sans décider lequel est le nôtre", () => {
    // La ligue numérote A et B sans privilégier personne. Décider ici que A est « nous » ferait
    // afficher un 4-1 gagné sur une rencontre perdue — il n'y a qu'une mesure, elle ne fait pas
    // une règle. C'est à l'appelant de reconnaître son sigle.
    expect(feuille.codeA).toBe("VERR2");
    expect(feuille.codeB).toBe("VERR3");
  });

  it("donne chaque joueur avec son classement du soir", () => {
    // Le classement PUBLIÉ SUR LA FEUILLE est celui du jour de la rencontre : c'est lui qui
    // faisait foi pour l'ordre des simples ce soir-là, pas celui d'aujourd'hui.
    expect(feuille.lines[0].a).toEqual({
      name: "POPULU AXEL",
      regiid: "584882",
      clt: "4D",
      rang: 2021,
      rangM: 2107,
    });
    expect(feuille.lines[0].b).toMatchObject({ name: "BABLON XAVIER", clt: "5B", rang: 3311 });
  });

  it("lit un nom composé sans le tronquer sur son espace", () => {
    // « DE ABREU PAULO » — le nom de famille tient en deux mots. Découper sur l'espace en
    // ferait « DE » contre « ABREU PAULO », et plus aucun rapprochement ne marcherait.
    expect(feuille.lines[1].b?.name).toBe("DE ABREU PAULO");
  });

  it("dit qui a gagné chaque simple, d'après la marque de la ligue", () => {
    expect(feuille.lines.map((l) => l.winner)).toEqual(["A", "A", "B", "A", "A"]);
  });

  it("garde le score jeu par jeu TEL QUEL", () => {
    // Non découpé : on ne sait pas encore ce que la ligue écrit sur un forfait, et décider
    // maintenant qu'un « WO » vaut 0-0 serait inventer un résultat.
    expect(feuille.lines[0].score).toBe("11-6 11-3 8-11 11-0");
    expect(feuille.lines[3].score).toBe("7-11 11-4 9-11 13-11 11-8");
  });

  it("compte les jeux, ZÉRO COMPRIS", () => {
    // Un 3-0 est un score parfaitement ordinaire. Traiter le 0 comme une case vide (ce que fait
    // la lecture des RANGS, où zéro n'existe pas) effacerait la moitié des feuilles.
    expect(feuille.lines[1]).toMatchObject({ gamesA: 3, gamesB: 0, pointsA: 33, pointsB: 12 });
  });

  it("⚠️ RAPPORTE le total de la ligue, il ne le recalcule pas", () => {
    // Tout l'objet de cette lecture est de dire ce que la LIGUE publie, pour le confronter à
    // notre relevé. Un total qu'on aurait recompté soi-même ne confronterait plus rien : il
    // serait d'accord avec nous par construction, y compris quand la ligue ne l'est pas.
    expect(feuille.totals).toEqual({
      matchesA: 4,
      matchesB: 1,
      gamesA: 13,
      gamesB: 6,
      pointsA: 191,
      pointsB: 144,
    });
  });

  it("lit l'en-tête, et rend la journée AU FORMAT DE NOS RENCONTRES", () => {
    // « J1 » ici, « 1 » sur la fiche d'équipe. C'est ce format-ci que porte `Interclub.round`.
    expect(feuille).toMatchObject({
      division: "Hommes 4",
      group: "Poule A",
      round: "J1",
      venue: "SQUASH CLUB DE VERRIERES LE BUISSON",
      date: "2025-10-09",
      time: "20:00",
    });
  });

  it("lit l'heure écrite « 20-00 », que la fiche d'équipe écrit « 20:00 »", () => {
    // Les DEUX séparateurs existent sur la même épreuve. N'en accepter qu'un rendrait l'heure
    // nulle une fois sur deux, sans rien signaler.
    expect(feuille.time).toBe("20:00");
  });
});

describe("parseTieSheet — refuse de servir autre chose", () => {
  it("⚠️ jette si le fragment porte une AUTRE rencontre", () => {
    // Le tableau s'appelle `table_matchs` pour toutes les rencontres : rien dans sa structure ne
    // dit de laquelle il s'agit. Sans ce contrôle, une réponse fédérale qui ignore notre `tieid`
    // (elle le fait déjà sans `drawid`, cf. `standings.ts`) afficherait la feuille d'une autre
    // rencontre comme si c'était la nôtre — avec des noms crédibles et un score plausible.
    expect(() => parseTieSheet(html, "1643035")).toThrow(TieUnreadableError);
  });

  it("jette si le tableau des simples manque", () => {
    expect(() => parseTieSheet("<div>Erreur</div>", "1")).toThrow(TieUnreadableError);
  });

  it("rend une feuille SANS LIGNE si le tableau est là mais vide", () => {
    // Une rencontre à venir n'a pas de simple saisi. C'est un fait, pas une panne — et la
    // distinction est tout l'objet de `TieUnreadableError`.
    const vide = '<table id="table_matchs"><thead><tr><th>Match</th></tr></thead></table>';
    const f = parseTieSheet(vide, "1");
    expect(f.lines).toEqual([]);
    expect(f.totals).toBeNull();
  });

  it("jette si les colonnes de joueurs ne s'identifient plus", () => {
    // Les intitulés « A:… » / « B:… » sont le seul moyen de savoir quelle colonne est quelle
    // équipe. S'ils changent, tout ce qu'on croirait lire serait faux — les noms, donc les
    // rapprochements, donc le verdict.
    const change = `<table id="table_matchs"><tr>
      <td data-label="Match">Homme 1</td>
      <td data-label="Domicile">DUPONT JEAN (5A - 1 - 2)</td>
      <td data-label="Visiteur">MARTIN PAUL (5A - 3 - 4)</td>
    </tr></table>`;
    expect(() => parseTieSheet(change, "1")).toThrow(TieUnreadableError);
  });

  it("tolère les guillemets SIMPLES — squashnet a déjà basculé une fois", () => {
    const simple = "<table id='table_matchs'><tr>" +
      "<td data-label='Match'>Homme 1</td>" +
      "<td data-label='A:AAA' class='winner'>DUPONT JEAN (5A - 1 - 2)</td>" +
      "<td data-label='B:BBB'>MARTIN PAUL (5A - 3 - 4)</td>" +
      "</tr></table>";
    const f = parseTieSheet(simple, "1");
    expect(f.codeA).toBe("AAA");
    expect(f.lines[0].winner).toBe("A");
  });

  it("rend un simple NON SAISI sans inventer de joueur", () => {
    // Une case vide reste vide : un joueur inventé entrerait dans les rapprochements.
    const partiel = `<table id="table_matchs"><tr>
      <td data-label="Match">Homme 1</td>
      <td data-label="A:AAA"></td>
      <td data-label="B:BBB"></td>
      <td data-label="Score"></td>
    </tr></table>`;
    const f = parseTieSheet(partiel, "1");
    expect(f.lines[0]).toMatchObject({ a: null, b: null, score: null, winner: null });
  });

  it("lit un joueur SANS parenthèses plutôt que de le perdre", () => {
    // Un joueur non classé, ou une feuille d'un format antérieur. Le nom suffit au
    // rapprochement ; exiger les trois valeurs ferait disparaître le joueur de la feuille.
    const nu = `<table id="table_matchs"><tr>
      <td data-label="Match">Homme 1</td>
      <td data-label="A:AAA">DUPONT JEAN</td>
      <td data-label="B:BBB">MARTIN PAUL (NC - 9389 - 9389)</td>
    </tr></table>`;
    const f = parseTieSheet(nu, "1");
    expect(f.lines[0].a).toEqual({ name: "DUPONT JEAN", regiid: null, clt: null, rang: null, rangM: null });
    expect(f.lines[0].b).toMatchObject({ clt: "NC", rang: 9389 });
  });
});
