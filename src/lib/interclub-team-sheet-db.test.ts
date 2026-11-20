import { describe, it, expect, beforeEach, vi } from "vitest";

// LE PRÉCHARGEMENT DES FICHES JOUEURS, PAR LE CRON D'APRÈS-MATCH.
//
// Ce qu'on tient : seules les équipes qui ont un simple publié sans joueurs coûtent quelque
// chose ; le budget borne les requêtes et reporte le reste ; un échec n'emporte pas la suite ;
// une fiche déjà relue après la rencontre ne repart pas chez la ligue.

const tally = { won: 0, lost: 0, diff: 0 };
const row = (code: string, snTeamId: string, rank: number) => ({
  rank,
  name: code,
  code,
  snTeamId,
  points: 0,
  played: 0,
  won: 0,
  drawWon: 0,
  drawLost: 0,
  lost: 0,
  matches: tally,
  games: tally,
  rallies: tally,
});

const vide = (order: number, score: string | null) => ({
  order,
  label: `Homme ${order}`,
  home: null,
  away: null,
  score,
  winner: null,
});
const tie = (homeCode: string, awayCode: string, lines: unknown[]) => ({
  round: "J1",
  date: "2026-10-08",
  time: "20:00",
  dateConfirmed: true,
  homeCode,
  awayCode,
  homeName: null,
  awayName: null,
  scoreHome: 0,
  scoreAway: 4,
  lines,
});

const h = vi.hoisted(() => ({
  ties: [] as unknown[],
  rosters: new Map<string, { players: { name: string; regiid: string | null }[] }>(),
  fiches: new Map<string, { player: unknown; fetchedAt: Date }>(),
  fetchPlayer: vi.fn(),
  stored: [] as string[],
  refreshRosters: vi.fn(async () => []),
}));

vi.mock("./db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async () => [
        {
          id: "t1",
          snEventId: "ev",
          snDrawId: "d",
          snRoundId: "R",
          snStandingsJson: JSON.stringify([row("CAL", "100", 1), row("VERR3", "200", 2), row("AQISSY", "300", 3)]),
          snStandingsAt: new Date("2026-10-09T00:00:00Z"),
        },
      ]),
    },
    squashnetTeamRoster: {
      findUnique: vi.fn(async () => ({ fetchedAt: new Date("2026-10-09T00:00:00Z") })),
    },
  },
}));
vi.mock("./interclub-pool-db", () => ({
  loadPool: vi.fn(async () => ({ ties: h.ties, fetchedAt: new Date("2026-10-09T00:00:00Z") })),
  loadPlayers: vi.fn(async (ids: string[]) => new Map(ids.filter((i) => h.fiches.has(i)).map((i) => [i, h.fiches.get(i)!]))),
  loadPlayer: vi.fn(),
  storePlayer: vi.fn(async (p: { regiid: string }) => {
    h.stored.push(p.regiid);
  }),
}));
vi.mock("./interclub-roster-db", () => ({
  DELAI_MS: 0,
  ECHEC_REPOS_MS: 15 * 60_000,
  ROSTER_FRAIS_JOURS: 7,
  loadRosters: vi.fn(async (ids: string[]) => new Map(ids.filter((i) => h.rosters.has(i)).map((i) => [i, { ...h.rosters.get(i)!, club: null, captain: null }]))),
  refreshRosters: (...a: unknown[]) => h.refreshRosters(...(a as [])),
}));
vi.mock("./interclub-standings", () => ({ refreshTeamStandings: vi.fn() }));
vi.mock("./squashnet/player", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./squashnet/player")>()),
  fetchPlayer: (...a: unknown[]) => h.fetchPlayer(...a),
}));

import { oublierEchecsFiches, prechargerFichesPoules } from "./interclub-team-sheet-db";

const NOW = new Date("2026-10-10T08:00:00Z");
const joueurs = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i}`, regiid: `${prefix}${i}` }));

beforeEach(() => {
  oublierEchecsFiches();
  h.ties = [tie("CAL", "VERR3", [vide(1, "3-11 7-11 11-7 6-11")]), tie("AQISSY", "VERR3", [])];
  h.rosters = new Map([
    ["100", { players: joueurs("c", 3) }],
    ["200", { players: joueurs("v", 2) }],
    ["300", { players: joueurs("a", 4) }],
  ]);
  h.fiches = new Map();
  h.stored = [];
  h.fetchPlayer.mockReset().mockImplementation(async (regiid: string) => ({ regiid, name: regiid, matches: [] }));
  h.refreshRosters.mockClear();
});

describe("prechargerFichesPoules", () => {
  it("ne lit que les fiches des équipes qui ont un simple sans joueurs", async () => {
    const r = await prechargerFichesPoules(["R"], { now: NOW, delaiMs: 0 });
    expect(r).toEqual({ equipes: 2, lues: 5, failed: 0, reportees: 0 });
    expect(h.stored.sort()).toEqual(["c0", "c1", "c2", "v0", "v1"]);
    // AQISSY n'a rien à compléter : ni effectif, ni fiche.
    expect(h.refreshRosters.mock.calls.map((c) => (c as unknown[])[0])).toEqual([["100"], ["200"]]);
  });

  it("ignore une poule qui n'est pas demandée", async () => {
    expect(await prechargerFichesPoules(["autre"], { now: NOW, delaiMs: 0 })).toEqual({
      equipes: 0,
      lues: 0,
      failed: 0,
      reportees: 0,
    });
  });

  it("borne les requêtes et reporte le reste", async () => {
    const r = await prechargerFichesPoules(["R"], { now: NOW, delaiMs: 0, max: 2 });
    expect(r.lues).toBe(2);
    expect(r.reportees).toBe(3);
  });

  it("une fiche en échec n'emporte pas les autres, et n'est pas retentée aussitôt", async () => {
    h.fetchPlayer.mockImplementation(async (regiid: string) => {
      if (regiid === "c1") throw new Error("muet");
      return { regiid, name: regiid, matches: [] };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await prechargerFichesPoules(["R"], { now: NOW, delaiMs: 0 })).toMatchObject({ lues: 4, failed: 1 });
    h.fetchPlayer.mockClear();
    await prechargerFichesPoules(["R"], { now: NOW, delaiMs: 0 });
    expect(h.fetchPlayer.mock.calls.map((c) => c[0])).not.toContain("c1");
    warn.mockRestore();
  });

  it("une fiche relue après la rencontre ne repart pas chez la ligue", async () => {
    const recente = { player: { regiid: "c0", name: "c0", matches: [] }, fetchedAt: new Date("2026-10-09T10:00:00Z") };
    h.fiches = new Map([["c0", recente]]);
    await prechargerFichesPoules(["R"], { now: NOW, delaiMs: 0 });
    expect(h.stored).not.toContain("c0");
  });
});
