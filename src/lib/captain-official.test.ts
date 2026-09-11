import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTieSheet } from "./squashnet/tie";
import type { TieSheet } from "./squashnet/tie";
import {
  compareOfficial,
  describeOfficial,
  officialAbsent,
  ourSide,
  tieUrl,
  type OurLine,
} from "./captain-official";

// ============================================================================
//  CONFRONTER NOTRE RELEVÉ À LA FEUILLE PUBLIÉE.
//
//  Une erreur de saisie fédérale ne produit ni message ni alerte : elle produit
//  un classement de fin de saison. Ces tests portent sur les deux façons de se
//  tromper en la cherchant — comparer à l'envers (côté A pris pour le nôtre), et
//  confondre « la ligue n'a rien saisi » avec « on n'a pas su lire ».
// ============================================================================

const feuille = parseTieSheet(
  readFileSync(
    join(__dirname, "squashnet", "__fixtures__", "rencontre-2026-1643001-feuille.html"),
    "utf8",
  ),
  "1643001",
);

/** Le relevé qui CONCORDE avec la feuille réelle, vu du côté de Verrieres 2 (côté A). */
const releveConforme: OurLine[] = [
  { order: 1, homeDisplayName: "POPULU AXEL", awayName: "BABLON XAVIER", gamesHome: 3, gamesAway: 1, winner: "home" },
  { order: 2, homeDisplayName: "GOLLOT ENGUERRAN", awayName: "DE ABREU PAULO", gamesHome: 3, gamesAway: 0, winner: "home" },
  { order: 3, homeDisplayName: "LECOMTE ARNAUD", awayName: "MICHEL MARC", gamesHome: 1, gamesAway: 3, winner: "away" },
  { order: 4, homeDisplayName: "PETEL JULIEN", awayName: "BEZELGA CHRISTOPHE", gamesHome: 3, gamesAway: 2, winner: "home" },
  { order: 5, homeDisplayName: "TRONCHE GUILLAUME", awayName: "DOUSSERON PASCAL", gamesHome: 3, gamesAway: 0, winner: "home" },
];

describe("ourSide — de quel côté sommes-nous ?", () => {
  it("reconnaît notre sigle", () => {
    expect(ourSide(feuille, { ourCode: "VERR2" })).toBe("A");
    expect(ourSide(feuille, { ourCode: "VERR3" })).toBe("B");
  });

  it("reconnaît le sigle de L'ADVERSAIRE — c'est celui qu'on a le plus souvent", () => {
    // Le roster d'en face est en cache (on le télécharge pour composer) ; le nôtre, pas
    // forcément. Ne savoir lire que notre propre sigle laisserait la confrontation sans côté
    // dans le cas le plus courant.
    expect(ourSide(feuille, { opponentCode: "VERR3" })).toBe("A");
    expect(ourSide(feuille, { opponentCode: "VERR2" })).toBe("B");
  });

  it("retombe sur les NOMS ALIGNÉS quand aucun sigle n'est connu", () => {
    // Ce témoin-là est à nous : il ne dépend d'aucun cache fédéral.
    expect(ourSide(feuille, { ourNames: releveConforme.map((l) => l.homeDisplayName) })).toBe("A");
    expect(ourSide(feuille, { ourNames: releveConforme.map((l) => l.awayName) })).toBe("B");
  });

  it("apparie les noms quel que soit l'ORDRE des mots", () => {
    // La feuille écrit « POPULU AXEL », notre appli affiche « Axel Populu ».
    expect(ourSide(feuille, { ourNames: ["Axel Populu", "Enguerran Gollot"] })).toBe("A");
  });

  it("⚠️ rend NULL plutôt que de parier", () => {
    // Un côté deviné a une chance sur deux d'inverser le score. Afficher « on n'a pas su
    // rapprocher » coûte infiniment moins cher qu'annoncer une victoire imaginaire.
    expect(ourSide(feuille, {})).toBeNull();
    expect(ourSide(feuille, { ourCode: "CHAV4" })).toBeNull();
    expect(ourSide(feuille, { ourNames: ["INCONNU TOTAL"] })).toBeNull();
  });

  it("ne tranche pas quand les deux côtés portent autant de nos noms", () => {
    // Deux équipes d'un même club peuvent aligner des homonymes.
    expect(ourSide(feuille, { ourNames: ["POPULU AXEL", "BABLON XAVIER"] })).toBeNull();
  });
});

describe("compareOfficial — la ligue publie 4-1, notre relevé dit 4-1", () => {
  it("ne relève AUCUN écart quand tout concorde", () => {
    const o = compareOfficial(releveConforme, feuille, "A", 5);
    expect(o).toMatchObject({ status: "match", home: 4, away: 1, oursHome: 4, oursAway: 1 });
    expect(o.problems).toEqual([]);
    expect(describeOfficial(o)).toBe("La ligue publie 4-1, comme notre relevé.");
  });

  it("remet le score DANS NOTRE SENS quand nous sommes le côté B", () => {
    // Vu de Verrieres 3, la même feuille dit 1-4. C'est l'inversion qui rendrait tout faux si
    // le côté était deviné.
    const vuDeB = releveConforme.map((l) => ({
      ...l,
      homeDisplayName: l.awayName,
      awayName: l.homeDisplayName,
      gamesHome: l.gamesAway,
      gamesAway: l.gamesHome,
      winner: l.winner === "home" ? ("away" as const) : ("home" as const),
    }));
    const o = compareOfficial(vuDeB, feuille, "B", 5);
    expect(o).toMatchObject({ status: "match", home: 1, away: 4, oursHome: 1, oursAway: 4 });
  });

  it("dit l'écart de SCORE en constat, jamais en accusation", () => {
    const faux = releveConforme.map((l) =>
      l.order === 3 ? { ...l, gamesHome: 3, gamesAway: 1, winner: "home" as const } : l,
    );
    const o = compareOfficial(faux, feuille, "A", 5);
    expect(o.status).toBe("diverges");
    expect(o.problems).toContain("La ligue publie 4-1 ; notre relevé dit 5-0.");
    // « ne concorde pas », et pas « ils se sont trompés » : c'est peut-être NOTRE relevé qui
    // est faux, et rien ici ne permet de le savoir.
    expect(o.problems.join(" ")).not.toMatch(/erreur|trompé|faute/i);
  });

  it("relève un écart de JEUX même quand le vainqueur est le même", () => {
    // ⚠️ CE CAS EST LA RAISON D'ÊTRE DE LA COMPARAISON FINE. Un 3-2 publié en 3-0 donne le même
    // vainqueur, donc le même score de rencontre — mais pas les mêmes points au classement.
    // S'arrêter au vainqueur laisserait passer exactement l'erreur qui coûte une montée.
    const jeuxFaux = releveConforme.map((l) =>
      l.order === 4 ? { ...l, gamesAway: 0 } : l,
    );
    const o = compareOfficial(jeuxFaux, feuille, "A", 5);
    expect(o.status).toBe("diverges");
    expect(o.problems).toContain(
      "Simple n° 4 : la ligue publie 3-2 en jeux, notre relevé dit 3-0.",
    );
    // Le score de la rencontre, lui, concorde : c'est bien le seul écart.
    expect(o.home).toBe(4);
    expect(o.problems).toHaveLength(1);
  });

  it("relève un joueur différent de chaque côté", () => {
    const autre = releveConforme.map((l) =>
      l.order === 2 ? { ...l, homeDisplayName: "MARTIN OLIVIER", awayName: "MICHEL MARC" } : l,
    );
    const o = compareOfficial(autre, feuille, "A", 5);
    expect(o.problems).toContain(
      "Simple n° 2 : la ligue nous fait jouer « GOLLOT ENGUERRAN », notre relevé dit « MARTIN OLIVIER ».",
    );
    expect(o.problems).toContain(
      "Simple n° 2 : la ligue aligne en face « DE ABREU PAULO », notre relevé dit « MICHEL MARC ».",
    );
  });

  it("rapproche PAR NUMÉRO DE SIMPLE, pas par position", () => {
    // Une feuille où un simple manque décalerait toute comparaison positionnelle : on
    // comparerait le troisième simple au quatrième, et on produirait quatre écarts là où il
    // n'y en a qu'un.
    const troue: TieSheet = { ...feuille, lines: feuille.lines.filter((l) => l.label !== "Homme 3") };
    const o = compareOfficial(releveConforme, troue, "A", 5);
    expect(o.problems).toEqual(["Simple n° 3 : absent de la feuille fédérale."]);
  });

  it("dit aussi l'inverse : saisi chez la ligue, absent de notre relevé", () => {
    const o = compareOfficial(releveConforme.slice(0, 4), feuille, "A", 5);
    expect(o.problems).toContain("Simple n° 5 : saisi chez la ligue, absent de notre relevé.");
  });
});

describe("compareOfficial — les états qui ne se confondent pas", () => {
  it("« la ligue n'a rien saisi » n'est pas « on n'a pas su lire »", () => {
    // Les deux appellent des gestes opposés : relancer l'adversaire, ou réessayer la lecture.
    const vide: TieSheet = { ...feuille, lines: [], totals: null };
    expect(compareOfficial(releveConforme, vide, "A", 5).status).toBe("empty");
    expect(compareOfficial(releveConforme, null, null, 5).status).toBe("unread");
  });

  it("« pas d'identifiant fédéral » n'est ni l'un ni l'autre", () => {
    // Rien à aller chercher : c'est un import de calendrier qu'il faut, pas une relance.
    const o = officialAbsent(releveConforme);
    expect(o).toMatchObject({ status: "absent", url: null, oursHome: 4, oursAway: 1 });
  });

  it("annonce une saisie EN COURS plutôt qu'une divergence", () => {
    // Une rencontre à moitié saisie n'est pas une anomalie ; crier « divergence » un mardi soir
    // enverrait un capitaine relancer quelqu'un qui est en train de saisir.
    const moitie: TieSheet = {
      ...feuille,
      lines: feuille.lines.slice(0, 3),
      totals: { matchesA: 2, matchesB: 1, gamesA: 7, gamesB: 4, pointsA: 105, pointsB: 74 },
    };
    const o = compareOfficial(releveConforme, moitie, "A", 5);
    expect(o.status).toBe("partial");
    expect(describeOfficial(o)).toBe("Saisie fédérale en cours : 2-1 pour l'instant.");
  });

  it("⚠️ NE COMPARE RIEN quand notre côté est inconnu", () => {
    // Comparer à l'envers produirait une liste d'écarts entièrement fausse — et un score
    // inversé, parfaitement crédible.
    const o = compareOfficial(releveConforme, feuille, null, 5);
    expect(o.status).toBe("unread");
    expect(o.home).toBeNull();
    expect(o.away).toBeNull();
    expect(o.problems[0]).toMatch(/impossible de reconnaître notre équipe/);
  });

  it("garde NOTRE score même quand la ligue est muette", () => {
    // L'écran affiche toujours ce qu'on a relevé : la lecture fédérale est un plus, pas une
    // condition.
    expect(compareOfficial(releveConforme, null, null, 5)).toMatchObject({
      oursHome: 4,
      oursAway: 1,
    });
  });
});

describe("tieUrl", () => {
  it("mène à la feuille publique, celle qu'on ouvre pour vérifier de ses yeux", () => {
    expect(tieUrl("1643001")).toContain("tieid=1643001");
    expect(tieUrl("1643001")).toMatch(/^https:\/\/www\.squashnet\.fr\//);
  });
});
