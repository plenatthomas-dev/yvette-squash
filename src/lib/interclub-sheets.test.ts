import { describe, it, expect, beforeEach, vi } from "vitest";

// LES FEUILLES DE MATCH OFFICIELLES — lesquelles on relit, et ce qu'on en écrit.
//
// Deux propriétés portent le palmarès entier :
//   * on RATTRAPE la saison déjà jouée (feuille absente ou incomplète), puis on ne relit plus
//     une feuille complète hors de la fenêtre d'après-match ;
//   * une feuille VIDE n'écrase jamais rien : la ligue qui ne répond rien n'efface pas ce
//     qu'elle a déjà publié.

const h = vi.hoisted(() => ({
  team: { snTeamId: "T1" } as { snTeamId: string | null } | null,
  fixtures: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  sheets: {} as Record<string, unknown>,
  tieIdsRefreshed: 0,
}));

vi.mock("./db", () => ({
  prisma: {
    interclubTeam: { findUnique: vi.fn(async () => h.team) },
    interclub: {
      findMany: vi.fn(async () => h.fixtures),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        h.updates.push(args);
      }),
    },
    squashnetTeamRoster: {
      findMany: vi.fn(async () => [
        { snTeamId: "T1", code: "YVET1" },
        { snTeamId: "OPP", code: "VERR2" },
      ]),
    },
  },
}));
vi.mock("./interclub-roster-db", () => ({
  refreshRosters: vi.fn(async () => []),
  loadRosters: vi.fn(async () => new Map()),
}));
vi.mock("./interclub-tie-db", () => ({
  refreshOwnTieIds: vi.fn(async () => {
    h.tieIdsRefreshed += 1;
    for (const f of h.fixtures) f.snTieId ??= "tie-" + String(f.id);
  }),
  readTieSheet: vi.fn(async (id: string) =>
    id in h.sheets ? { sheet: h.sheets[id], error: null } : { sheet: null, error: "failed" },
  ),
}));
// La porte du classement lit le Data Cache de Next : hors sujet ici.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));

import { refreshTeamSheets, sheetDue } from "./interclub-sheets";

const joueur = (name: string) => ({ name, regiid: null, clt: null, rang: null, rangM: null });
const ligne = (winner: "A" | "B" | null = "A") => ({
  label: "Homme 1",
  a: joueur("POPULU AXEL"),
  b: joueur("DUPONT JEAN"),
  score: null,
  winner,
  gamesA: 3,
  gamesB: 0,
  pointsA: 33,
  pointsB: 10,
});
const feuille = (id: string, lines: unknown[], codeA = "YVET1", codeB = "VERR2") => ({
  snTieId: id,
  codeA,
  codeB,
  division: null,
  group: null,
  round: null,
  venue: null,
  date: null,
  time: null,
  lines,
  totals: null,
});

// 18 octobre 2026, 23 h à Paris (heure d'été : UTC+2).
const NOW = new Date("2026-10-18T21:00:00Z");

describe("sheetDue", () => {
  const complete = JSON.stringify(feuille("1", [ligne()]));

  it("relit une rencontre passée sans feuille, ou à la feuille incomplète", () => {
    expect(sheetDue({ date: "2026-09-01", snSheetJson: null, snSheetSide: null }, NOW)).toBe(true);
    expect(
      sheetDue({ date: "2026-09-01", snSheetJson: JSON.stringify(feuille("1", [ligne(null)])), snSheetSide: "A" }, NOW),
    ).toBe(true);
  });

  it("relit une feuille complète dont notre côté n'a pas été reconnu", () => {
    expect(sheetDue({ date: "2026-09-01", snSheetJson: complete, snSheetSide: null }, NOW)).toBe(true);
  });

  it("NE RELIT PLUS une feuille complète hors de la fenêtre d'après-match", () => {
    expect(sheetDue({ date: "2026-09-01", snSheetJson: complete, snSheetSide: "A" }, NOW)).toBe(false);
  });

  it("relit en fenêtre d'après-match même une feuille complète — la ligue corrige", () => {
    expect(sheetDue({ date: "2026-10-15", snSheetJson: complete, snSheetSide: "A" }, NOW)).toBe(true);
  });

  it("le jour du match, rien avant 22 h ; à venir, jamais", () => {
    const f = { date: "2026-10-18", snSheetJson: null, snSheetSide: null };
    expect(sheetDue(f, new Date("2026-10-18T17:00:00Z"))).toBe(false);
    expect(sheetDue(f, NOW)).toBe(true);
    expect(sheetDue({ ...f, date: "2026-10-25" }, NOW)).toBe(false);
  });
});

describe("refreshTeamSheets", () => {
  beforeEach(() => {
    h.team = { snTeamId: "T1" };
    h.fixtures = [];
    h.updates = [];
    h.sheets = {};
    h.tieIdsRefreshed = 0;
  });

  const rencontre = (over: Record<string, unknown>) => ({
    id: "f1",
    date: "2026-10-01",
    snTieId: "100",
    snOpponentTeamId: "OPP",
    snSheetJson: null,
    snSheetSide: null,
    ...over,
  });

  it("enregistre la feuille et NOTRE CÔTÉ, reconnu au sigle", async () => {
    h.fixtures = [rencontre({})];
    h.sheets = { "100": feuille("100", [ligne()], "VERR2", "YVET1") };
    const r = await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(r).toMatchObject({ read: 1, stored: 1, failed: 0 });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].data.snSheetSide).toBe("B");
    expect(JSON.parse(String(h.updates[0].data.snSheetJson)).snTieId).toBe("100");
  });

  it("N'ÉCRIT RIEN pour une feuille encore vide, ni pour une lecture en échec", async () => {
    h.fixtures = [rencontre({}), rencontre({ id: "f2", snTieId: "200" })];
    h.sheets = { "100": feuille("100", []) };
    const r = await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(r).toMatchObject({ read: 2, stored: 0, empty: 1, failed: 1 });
    expect(h.updates).toEqual([]);
  });

  it("enregistre une feuille dont le côté est inconnu, mais le compte à part", async () => {
    h.fixtures = [rencontre({})];
    h.sheets = { "100": feuille("100", [ligne()], "XXX", "YYY") };
    const r = await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(r).toMatchObject({ stored: 1, unmatched: 1 });
    expect(h.updates[0].data.snSheetSide).toBeNull();
  });

  it("va chercher l'identifiant fédéral SEULEMENT s'il en manque un", async () => {
    h.fixtures = [rencontre({})];
    h.sheets = { "100": feuille("100", [ligne()]) };
    await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(h.tieIdsRefreshed).toBe(0);

    h.fixtures = [rencontre({ snTieId: null })];
    h.sheets = { "tie-f1": feuille("tie-f1", [ligne()]) };
    const r = await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(h.tieIdsRefreshed).toBe(1);
    expect(r.stored).toBe(1);
  });

  it("ne relit pas une feuille complète hors fenêtre", async () => {
    h.fixtures = [rencontre({ snSheetJson: JSON.stringify(feuille("100", [ligne()])), snSheetSide: "A" })];
    const r = await refreshTeamSheets("t1", { now: NOW, delaiMs: 0 });
    expect(r.read).toBe(0);
  });

  it("une équipe sans teamid fédéral : rien à faire, rien d'anormal", async () => {
    h.team = { snTeamId: null };
    expect(await refreshTeamSheets("t1", { now: NOW })).toEqual({
      read: 0,
      stored: 0,
      empty: 0,
      unmatched: 0,
      failed: 0,
    });
  });
});
