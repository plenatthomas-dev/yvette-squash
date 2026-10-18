import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PoolUnreadableError, parsePool, parsePoolTies } from "./pool";

// ============================================================================
//  LES RENCONTRES DE LA POULE — critérium 2026-27, Hommes 4, poule B.
//
//  Fragment capté tel quel le 2026-10-18 (`ic_a=394242`, eventid + drawid 52162
//  + roundid 383987) : le classement, puis les 110 rencontres de la poule. Deux
//  journées jouées. Les chiffres attendus sont ceux que publie l'appli Squash
//  App sur les mêmes rencontres.
// ============================================================================

const html = readFileSync(join(__dirname, "__fixtures__", "poule-2027-h4-poule-b.html"), "utf8");

describe("parsePoolTies — les rencontres réelles de la poule B", () => {
  const ties = parsePoolTies(html);

  it("écarte les rencontres contre l'équipe fictive EXEMPT", () => {
    // 11 équipes dont EXEMPT : chaque journée en compte 5 vraies et une exemption.
    expect(ties.some((t) => t.homeCode === "EXEMPT" || t.awayCode === "EXEMPT")).toBe(false);
    expect(ties.length).toBeGreaterThan(80);
    expect(ties.length).toBeLessThan(110);
  });

  it("lit J1 VERR5–AQISSY : receveur à gauche, total publié 1-3", () => {
    const t = ties.find((x) => x.round === "J1" && x.homeCode === "VERR5");
    expect(t).toMatchObject({
      date: "2026-10-08",
      time: "20:00",
      dateConfirmed: true,
      awayCode: "AQISSY",
      homeName: "Verrieres 5",
      awayName: "Squash in Issy",
      scoreHome: 1,
      scoreAway: 3,
    });
    expect(t?.lines).toHaveLength(4);
  });

  it("lit chaque simple : joueurs, classement, score tel quel et vainqueur", () => {
    const t = ties.find((x) => x.round === "J1" && x.homeCode === "VERR5")!;
    expect(t.lines[2]).toEqual({
      order: 3,
      label: "Homme 3",
      home: { name: "DETRY XAVIER", regiid: "647808", clt: "5B", rang: 3489, rangM: 4120 },
      away: { name: "KADI RAFIK", regiid: "644801", clt: "5B", rang: 4086, rangM: 4976 },
      score: "5-11 8-11 15-13 7-11",
      winner: "away",
    });
    // Le seul simple gagné par Verrières, au cinquième jeu.
    expect(t.lines[3]).toMatchObject({ score: "11-1 11-5 7-11 10-12 11-9", winner: "home" });
    expect(t.lines[3].away?.clt).toBe("NC");
  });

  it("le receveur reste à gauche quand c'est lui qui gagne (AQISSY 4-0 VERR4)", () => {
    const t = ties.find((x) => x.round === "J2" && x.homeCode === "AQISSY")!;
    expect(t).toMatchObject({ awayCode: "VERR4", homeName: "Squash in Issy", scoreHome: 4, scoreAway: 0 });
    expect(t.lines.every((l) => l.winner === "home")).toBe(true);
  });

  it("une rencontre à venir : score NULL (pas 0-0), joueurs et vainqueurs nuls", () => {
    // Les deux cases y portent la classe `winner` : la lire seule ferait gagner tout le monde.
    const t = ties.find((x) => x.round === "J3" && x.homeCode === "VERR3")!;
    expect(t).toMatchObject({ awayCode: "AQISSY", date: "2026-11-05", scoreHome: null, scoreAway: null });
    expect(t.homeName).toBeNull();
    expect(t.lines).toHaveLength(4);
    for (const l of t.lines) expect(l).toMatchObject({ home: null, away: null, score: null, winner: null });
  });

  it("seules les exemptions portaient le bouchon : toutes les vraies rencontres ont leur date", () => {
    expect(ties.every((t) => t.dateConfirmed)).toBe(true);
  });

  it("marque la date BOUCHON : plusieurs journées le même jour, aucune jouée", () => {
    const deplace = html.replaceAll("05-11-2026 20:00", "08-06-2027 20:00");
    const bouchons = parsePoolTies(deplace).filter((x) => x.date === "2027-06-08");
    expect(bouchons.map((x) => x.round)).toEqual(["J3", "J3", "J3", "J3"]);
    expect(bouchons.every((x) => !x.dateConfirmed)).toBe(true);
  });

  it("une date où un simple a été JOUÉ n'est jamais un bouchon", () => {
    // J1 et J2 réunis le même soir : deux journées, mais jouées — la date a eu lieu.
    const t = parsePoolTies(html.replaceAll("15-10-2026 20:00", "08-10-2026 20:00"));
    const soir = t.filter((x) => x.date === "2026-10-08");
    expect(new Set(soir.map((x) => x.round))).toEqual(new Set(["J1", "J2"]));
    expect(soir.every((x) => x.dateConfirmed)).toBe(true);
  });

  it("nos deux équipes ont leurs rencontres, l'une contre l'autre comprise", () => {
    const yvette = ties.filter((t) => [t.homeCode, t.awayCode].includes("YVETTE2"));
    expect(yvette.some((t) => t.homeCode === "YVETTE2" && t.awayCode === "YVETTE1")).toBe(true);
    const j2 = yvette.find((t) => t.round === "J2")!;
    expect(j2).toMatchObject({ homeCode: "YVETTE2", awayCode: "VERR3", scoreHome: 1, scoreAway: 3 });
    expect(j2.lines[0].home?.name).toBe("PLENAT THOMAS");
  });
});

describe("parsePoolTies — vide ou illisible", () => {
  it("aucun bloc : liste vide, pas une erreur (poule pas encore publiée)", () => {
    expect(parsePoolTies("<div>Rien</div>")).toEqual([]);
  });

  it("un en-tête tronqué jette, plutôt que de rendre une poule sans rencontre", () => {
    const casse = html.replace(/<th scope="col" class="text-left">VERR5<\/th>/, "");
    expect(() => parsePoolTies(casse)).toThrow(PoolUnreadableError);
  });

  it("des cases qui ne portent plus les sigles de l'en-tête jettent", () => {
    const casse = html.replace(/data-label="VERR5"/g, 'data-label="Equipe A"');
    expect(() => parsePoolTies(casse)).toThrow(PoolUnreadableError);
  });
});

describe("parsePool — classement et rencontres d'un même fragment", () => {
  it("lit les deux, et le classement survit à des rencontres illisibles", () => {
    const ok = parsePool(html);
    expect(ok.standings.find((r) => r.code === "AQISSY")).toMatchObject({ rank: 1, snTeamId: "176169" });
    expect(ok.ties?.length).toBeGreaterThan(80);
    expect(ok.tiesError).toBeNull();

    const casse = parsePool(html.replace(/data-label="VERR5"/g, 'data-label="Equipe A"'));
    expect(casse.standings.length).toBe(ok.standings.length);
    expect(casse.ties).toBeNull();
    expect(casse.tiesError).toMatch(/illisibles/);
  });
});
