import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTeamCalendar,
  ownFixtures,
  withTeamDates,
  fetchOwnFixtures,
  CalendarUnreadableError,
  type OwnTie,
} from "./calendar";
import { parseTeamRoster, type TeamTie } from "./roster";

// ============================================================================
//  LE CALENDRIER DE POULE FAUX, LA FICHE D'ÉQUIPE JUSTE — D4 poule B, 2026-27.
//
//  Deux fragments RÉELS, captés le 2026-09-26 :
//    POST index.php  ic_a=393986  eventid=bd775f1a…  drawid=52162  roundid=383987
//    POST index.php  ic_a=393480  teamid=176168  (Squash de l'Yvette 2)
//  L'exemption de Meudon a fait recalculer le calendrier : la poule rend dix-sept de nos vingt
//  rencontres au 08/06/2027, la fiche d'équipe donne les vraies dates — vérifiées par le
//  capitaine dans son espace squashnet. Ce fichier fige les deux, et ce qu'on en tire.
// ============================================================================

const fixture = (nom: string) => readFileSync(join(__dirname, "__fixtures__", nom), "utf8");
const POULE = fixture("calendrier-2027-d4-poule-b-bouchon.html");
const FICHE = fixture("equipe-2027-176168-fiche.html");

const YVETTE2 = "176168";
const ROUND = "383987";

const reseau = vi.hoisted(() => ({ par: {} as Record<string, string | Error> }));
vi.mock("./client", () => ({
  postAjax: async (p: Record<string, string>) => {
    const r = reseau.par[p.ic_a];
    if (r instanceof Error) throw r;
    return r ?? "";
  },
}));

beforeEach(() => {
  reseau.par = { "393986": POULE, "393480": FICHE };
});

const journee = (ties: OwnTie[], round: string) => ties.find((t) => t.round === round)!;

describe("les fragments réels", () => {
  const pool = parseTeamCalendar(POULE);
  const own = ownFixtures(pool, YVETTE2);
  const fiche = parseTeamRoster(FICHE, YVETTE2);
  const dates = withTeamDates(pool, own, fiche.ties, ROUND);

  it("la poule, seule, met presque tout à la date bouchon — c'est le défaut constaté", () => {
    expect(own).toHaveLength(20);
    expect(own.filter((t) => t.date === "2027-06-08")).toHaveLength(17);
  });

  it("la fiche rend à chaque journée sa vraie date", () => {
    expect(journee(dates, "J1").date).toBe("2026-10-08");
    expect(journee(dates, "J2").date).toBe("2026-10-15");
    expect(journee(dates, "J7").date).toBe("2026-12-10");
    expect(journee(dates, "J18").date).toBe("2027-04-01");
    expect(journee(dates, "J23").date).toBe("2027-05-20");
    expect(dates.filter((t) => t.date === "2027-06-08").map((t) => t.round).sort()).toEqual([
      "J10",
      "J22",
    ]);
  });

  it("les vraies dates sont confirmées, les deux exemptions restent prévisionnelles", () => {
    expect(dates.filter((t) => !t.dateConfirmed).map((t) => t.round).sort()).toEqual([
      "J10",
      "J22",
    ]);
  });

  it("ne touche qu'à la date et à l'heure : receveur, adversaire et lieu viennent de la poule", () => {
    dates.forEach((t, i) => {
      const { date: _d, time: _t, dateConfirmed: _c, ...reste } = t;
      const { date: _d2, time: _t2, dateConfirmed: _c2, ...avant } = own[i];
      expect(reste).toEqual(avant);
    });
    expect(journee(dates, "J1").time).toBe("20:00");
  });
});

describe("withTeamDates — ce qu'on refuse de deviner", () => {
  const base: OwnTie = {
    round: "J3",
    date: "2027-06-08",
    time: "20:00",
    home: true,
    opponent: "CAL Squash",
    opponentTeamId: "176164",
    venue: null,
    venueAddress: null,
    dateConfirmed: false,
  };
  const ligne = (over: Partial<TeamTie>): TeamTie => ({
    snTieId: "1",
    date: "2026-11-05",
    time: "20:30",
    round: "3",
    table: ROUND,
    opponentTeamId: "176164",
    opponentName: "CAL Squash",
    venue: null,
    result: "notPlayed",
    scoreFor: null,
    scoreAgainst: null,
    ...over,
  });

  it("prend date et heure de la fiche, et confirme", () => {
    expect(withTeamDates([], [base], [ligne({})], ROUND)[0]).toMatchObject({
      date: "2026-11-05",
      time: "20:30",
      dateConfirmed: true,
    });
  });

  it("ignore le tableau d'une AUTRE poule — la phase finale renumérote ses tours", () => {
    expect(withTeamDates([], [base], [ligne({ table: "999" })], ROUND)[0]).toEqual(base);
  });

  it("ignore une fiche rangée avant que la poule n'y soit notée", () => {
    expect(withTeamDates([], [base], [ligne({ table: undefined })], ROUND)[0]).toEqual(base);
  });

  it("garde la date de poule si l'adversaire ne correspond pas", () => {
    expect(withTeamDates([], [base], [ligne({ opponentTeamId: "1" })], ROUND)[0]).toEqual(base);
  });

  it("garde la date de poule si la fiche porte deux fois la journée", () => {
    const deux = [ligne({}), ligne({ snTieId: "2", date: "2026-11-12" })];
    expect(withTeamDates([], [base], deux, ROUND)[0]).toEqual(base);
  });

  it("« J03 » et « 3 » désignent la même journée", () => {
    expect(withTeamDates([], [{ ...base, round: "J03" }], [ligne({})], ROUND)[0].date).toBe(
      "2026-11-05",
    );
  });

  it("une date bouchon DE LA POULE reste prévisionnelle même si la fiche la porte seule", () => {
    const pool = ["J4", "J5"].map((round) => ({
      round,
      date: "2026-11-05",
      time: null,
      homeTeamId: "a",
      homeTeamName: "A",
      awayTeamId: "b",
      awayTeamName: "B",
      venue: null,
      venueAddress: null,
    }));
    expect(withTeamDates(pool, [base], [ligne({})], ROUND)[0].dateConfirmed).toBe(false);
  });
});

describe("fetchOwnFixtures", () => {
  it("rend les dates de la fiche", async () => {
    const ties = await fetchOwnFixtures("bd775f1a60dbeda0d8f73323538d8404", ROUND, YVETTE2);
    expect(journee(ties, "J1").date).toBe("2026-10-08");
  });

  it("une fiche muette fait échouer le tout, plutôt que de réannoncer les dates bouchon", async () => {
    reseau.par["393480"] = new Error("502");
    await expect(fetchOwnFixtures("e", ROUND, YVETTE2)).rejects.toThrow("502");
  });

  it("une fiche illisible se dit comme un calendrier illisible", async () => {
    reseau.par["393480"] = "<div>rien</div>";
    await expect(fetchOwnFixtures("e", ROUND, YVETTE2)).rejects.toBeInstanceOf(
      CalendarUnreadableError,
    );
  });

  it("ne lit pas la fiche quand la poule ne nous contient pas", async () => {
    reseau.par["393480"] = new Error("ne devait pas être appelée");
    expect(await fetchOwnFixtures("e", ROUND, "000")).toEqual([]);
  });
});
