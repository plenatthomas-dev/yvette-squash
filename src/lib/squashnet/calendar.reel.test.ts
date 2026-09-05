import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamCalendar, ownFixtures, calendarFingerprint } from "./calendar";

// ============================================================================
//  LE VRAI CALENDRIER DE L'ÉQUIPE — critérium 2025-2026, Hommes 4, poule IVD.
//
//  `calendar.test.ts` éprouve la grammaire du parseur sur des fragments taillés
//  à la main. Ce fichier-ci fait autre chose : il fige LE calendrier de NOTRE
//  équipe, capté tel quel sur squashnet, avec ses cinq journées, ses vrais
//  adversaires et ses vrais gymnases. Un parseur qui reste vert sur des
//  fragments d'école et se trompe sur la seule épreuve qui nous concerne
//  n'aurait rien prouvé du tout.
//
//  ⚠️ CE FICHIER A RÉVÉLÉ UN DÉFAUT, ET C'EST SA RAISON D'ÊTRE. On croyait
//  qu'`eventid` suffisait à désigner un calendrier. Faux : une épreuve contient
//  PLUSIEURS POULES, et sans `roundid` le site rend celle qu'il veut — sur
//  cette épreuve, une poule où l'Yvette ne figure pas (Jeu de Paume, Montmartre,
//  PUC, Vincennes…). L'import aurait donc rapporté zéro rencontre, sans erreur
//  et sans explication. D'où le troisième identifiant d'ancrage.
//
//  La fixture est un fragment RÉEL, enregistré le 2026-09-04 :
//    POST index.php  ic_a=393986  eventid=879981be…  roundid=370138
//  Elle est figée exprès : le test reste hors-ligne et rapide, et une évolution
//  du rendu de squashnet se verra à la prochaine capture, pas un soir de match.
// ============================================================================

const FRAGMENT = readFileSync(
  join(__dirname, "__fixtures__", "criterium-2026-yvette-d4.html"),
  "utf8",
);

/** Notre identifiant d'équipe dans cette épreuve. */
const YVETTE = "161092";

describe("critérium 2025-2026 — poule IVD, telle que la fédération la publie", () => {
  const ties = parseTeamCalendar(FRAGMENT);
  const notres = ownFixtures(ties, YVETTE);

  it("lit les cinq journées de la poule, et toutes leurs rencontres", () => {
    // Six équipes, cinq journées, trois rencontres par journée.
    expect(ties).toHaveLength(15);
    expect(new Set(ties.map((t) => t.round))).toEqual(
      new Set(["J01", "J02", "J03", "J04", "J05"]),
    );
  });

  it("retient les CINQ rencontres de l'Yvette, et elles seules", () => {
    // La poule compte quinze rencontres ; cinq sont les nôtres. `teamid` ne filtre rien côté
    // squashnet : c'est `ownFixtures` qui fait ce travail, et c'est ici qu'on le vérifie.
    expect(notres).toHaveLength(5);
  });

  it("date chaque journée exactement comme la ligue l'a publiée", () => {
    // Les vraies dates, celles sur lesquelles l'équipe s'est déplacée. Un décalage d'un jour
    // (fuseau, mois mal traduit) se verrait ici et nulle part ailleurs.
    expect(notres.map((f) => [f.round, f.date])).toEqual([
      ["J01", "2026-06-15"],
      ["J02", "2026-05-28"],
      ["J03", "2026-06-04"],
      ["J04", "2026-06-11"],
      ["J05", "2026-06-18"],
    ]);
  });

  it("prouve que la JOURNÉE et la DATE ne vont pas dans le même ordre", () => {
    // J01 se joue le 15 juin, APRÈS J02 (28 mai), J03 (4 juin) et J04 (11 juin) — un report,
    // sans doute, et elle se glisse entre J04 et J05.
    // C'est la démonstration en vrai de la décision du module : rapprocher deux calendriers par
    // la JOURNÉE et non par la date. Un rapprochement par date aurait vu ici cinq journées
    // « nouvelles » à chaque report, au lieu d'une journée déplacée.
    const parDate = [...notres].sort((a, b) => a.date.localeCompare(b.date));
    expect(parDate.map((f) => f.round)).toEqual(["J02", "J03", "J04", "J01", "J05"]);
  });

  it("dit chez qui l'on joue, et contre qui", () => {
    expect(notres.map((f) => [f.round, f.home, f.opponent])).toEqual([
      ["J01", true, "Chaville 4"],
      ["J02", true, "UCPA Meudon 2"],
      ["J03", false, "Liberty Country Club 3"],
      ["J04", false, "Liberty Country Club 2"],
      ["J05", true, "Verrieres 3"],
    ]);
  });

  it("porte le lieu, qui est l'information la plus utile en déplacement", () => {
    const j03 = notres.find((f) => f.round === "J03")!;
    expect(j03.home).toBe(false);
    expect(j03.venue).toBe("LIBERTY CLUB");
    expect(j03.venueAddress).toBeTruthy();

    // À domicile, notre propre complexe.
    expect(notres.find((f) => f.round === "J01")!.venue).toMatch(/BURES SUR YVETTE/i);
  });

  it("donne l'heure de chaque rencontre", () => {
    expect(notres.every((f) => f.time === "20:00")).toBe(true);
  });

  it("ne déclare AUCUNE date prévisionnelle : la poule est entièrement planifiée", () => {
    // Le repère de la date bouchon est « plusieurs journées le même jour ». Ici les cinq dates
    // sont distinctes, donc toutes fermes — et les notifications peuvent partir.
    expect(notres.every((f) => f.dateConfirmed)).toBe(true);
  });

  it("… et ce n'est pas un « true » écrit en dur : la même poule datée d'un seul jour bascule", () => {
    // ⚠️ CE QUE CE FICHIER NE PEUT PAS PROUVER. L'assertion ci-dessus passerait à l'identique
    // si `dateConfirmed` valait `true` en dur : notre poule est entièrement planifiée, aucune
    // fixture réelle à dates bouchon n'a été captée, et la branche « bouchon » n'est éprouvée
    // sur du vrai nulle part. C'est assumé, faute d'événement non planifié sous la main au
    // moment de la capture — l'événement d'essai qui la montrait (J11 à J14 le 30 juin 2026)
    // n'a jamais été enregistré en fixture.
    //
    // Ce qu'on peut prouver, et qui vaut mieux que rien : la déduction DISCRIMINE, et sur les
    // vraies rencontres de la poule. On repousse les cinq journées au même jour — comme le fait
    // une ligue qui n'a rien planifié —, et les cinq doivent basculer.
    const memeJour = ties.map((t) => ({ ...t, date: "2026-06-30" }));
    expect(ownFixtures(memeJour, YVETTE).every((f) => f.dateConfirmed)).toBe(false);
    // Deux rencontres d'une MÊME journée partagent évidemment leur date : c'est le nombre de
    // JOURNÉES qu'on compte, pas celui des rencontres. Sinon toute la poule serait bouchon.
    const uneJournee = ties.filter((t) => t.round === "J01");
    expect(uneJournee.length).toBeGreaterThan(1);
    expect(ownFixtures(uneJournee, YVETTE).every((f) => f.dateConfirmed)).toBe(true);
  });

  it("rend une empreinte stable, insensible à l'ordre des lignes", () => {
    // C'est elle qui décide si le contrôle hebdomadaire se tait. Sur le même calendrier lu
    // deux fois, elle doit être identique — y compris si squashnet réordonne ses journées.
    const inverse = ownFixtures([...ties].reverse(), YVETTE);
    expect(calendarFingerprint(inverse)).toBe(calendarFingerprint(notres));
  });
});
