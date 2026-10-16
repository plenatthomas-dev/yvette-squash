import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA RELECTURE D'APRÈS-MATCH DU CLASSEMENT.
//
// Deux choses à tenir, et aucune ne se voit à la relecture :
//   * un passage SANS fenêtre ouverte ne touche pas Postgres — ni le drapeau de fonction, ni
//     le suivi des crons. Le cron passe six fois par jour toute l'année, Neon s'endort après
//     5 minutes ;
//   * une équipe en échec n'emporte pas les autres.

const h = vi.hoisted(() => ({
  authorized: true,
  interclub: true,
  due: [] as string[],
  teams: [] as Array<Record<string, unknown>>,
  findManyArgs: [] as unknown[],
  /** Résultat de la relecture, par équipe ; une `Error` est levée. */
  results: {} as Record<string, unknown>,
  features: vi.fn(),
  runs: [] as unknown[][],
}));

vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({
  recordCronRun: vi.fn(async (...a: unknown[]) => {
    h.runs.push(a);
  }),
}));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => {
    h.features();
    return { interclub: h.interclub };
  },
}));
vi.mock("@/lib/interclub-standings", () => ({
  teamsDueForStandings: vi.fn(async () => h.due),
  refreshTeamStandings: vi.fn(async (team: { id: string }) => {
    const r = h.results[team.id];
    if (r instanceof Error) throw r;
    return r ?? { ok: true, rows: 8, at: new Date() };
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async (args: unknown) => {
        h.findManyArgs.push(args);
        return h.teams;
      }),
    },
  },
}));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as NextRequest;
const team = (id: string) => ({ id, snEventId: "ev", snDrawId: "47760", snRoundId: "370138" });

beforeEach(() => {
  h.authorized = true;
  h.interclub = true;
  h.due = [];
  h.teams = [];
  h.findManyArgs = [];
  h.results = {};
  h.features.mockClear();
  h.runs = [];
});

describe("GET /api/cron/interclub-standings", () => {
  it("refuse un appel sans le secret", async () => {
    h.authorized = false;
    expect((await GET(req())).status).toBe(401);
  });

  it("hors fenêtre, ne réveille pas la base", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(h.features).not.toHaveBeenCalled();
    expect(h.findManyArgs).toHaveLength(0);
    expect(h.runs).toHaveLength(0);
  });

  it("se tait si l'interclub est désactivé", async () => {
    h.due = ["t1"];
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
    expect(h.findManyArgs).toHaveLength(0);
  });

  it("ne relit que les équipes en fenêtre, et entièrement ancrées", async () => {
    h.due = ["t1"];
    h.teams = [team("t1")];
    await GET(req());
    const where = (h.findManyArgs[0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({
      id: { in: ["t1"] },
      snEventId: { not: null },
      snDrawId: { not: null },
      snRoundId: { not: null },
    });
  });

  it("une équipe en échec n'emporte pas les autres", async () => {
    h.due = ["t1", "t2", "t3"];
    h.teams = [team("t1"), team("t2"), team("t3")];
    h.results = { t1: new Error("base"), t2: { ok: false, reason: "unreachable" } };
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ teams: 3, refreshed: 1, failed: 2 });
    expect(h.runs[0][0]).toBe("interclub-standings");
    expect(h.runs[0][1]).toBe(false);
  });

  it("un classement encore vide n'est pas une panne", async () => {
    h.due = ["t1"];
    h.teams = [team("t1")];
    h.results = { t1: { ok: false, reason: "empty" } };
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ refreshed: 0, empty: 1, failed: 0 });
    expect(h.runs[0][1]).toBe(true);
  });
});
