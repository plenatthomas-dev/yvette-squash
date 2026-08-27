import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  match: null as null | Record<string, unknown>,
  siblings: [] as Array<Record<string, unknown>>,
  updated: null as null | Record<string, unknown>,
  createdGames: null as null | Array<Record<string, unknown>>,
  deleteCalls: 0,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubMatch: {
      findUnique: vi.fn(async () => h.match),
      findMany: vi.fn(async () => h.siblings),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return {};
      }),
    },
    interclubGame: {
      deleteMany: vi.fn(async () => {
        h.deleteCalls += 1;
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        h.createdGames = args.data;
        return { count: args.data.length };
      }),
    },
    interclub: { update: vi.fn(async () => ({})) },
  },
}));

import { PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "f1", mid: "m1" }) };
const put = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

const RECENT = new Date(Date.now() - 30_000);
const OLD = new Date(Date.now() - 60 * 60_000);

const liveSnap = { current: { home: 7, away: 4 }, serving: "home", servingBox: "left", awaitingServeBox: false };

const freshMatch = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  interclubId: "f1",
  scorerId: "u1",
  scorerClaimedAt: RECENT,
  updatedAt: RECENT,
  games: [] as Array<{ pointsHome: number; pointsAway: number }>,
  homeDisplayName: "Tom",
  awayName: "Gégé",
  interclub: {
    id: "f1",
    bestOf: 5,
    matchCount: 4,
    status: "live",
    opponent: "Massy",
    teamId: "team-1",
    team: { name: "Équipe 1" },
  },
  ...over,
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.match = freshMatch();
  h.siblings = [{ gamesHome: null, status: "live" }];
  h.updated = null;
  h.createdGames = null;
  h.deleteCalls = 0;
});

describe("PUT .../live", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(401);
  });

  it("refuse un corps sans liste de jeux", async () => {
    expect((await PUT(put({}), ctx)).status).toBe(400);
  });

  it("enregistre l'instantané du jeu en cours", async () => {
    const res = await PUT(put({ games: [], live: liveSnap }), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(String(h.updated?.liveJson))).toMatchObject({ current: { home: 7, away: 4 } });
    expect(h.updated).toMatchObject({ status: "live", scorerId: "u1" });
  });

  it("n'écrit PAS les jeux quand ils n'ont pas bougé — c'est le chemin chaud de la soirée", async () => {
    h.match = freshMatch({ games: [{ pointsHome: 11, pointsAway: 5 }] });
    await PUT(put({ games: [{ home: 11, away: 5 }], live: liveSnap }), ctx);
    expect(h.deleteCalls).toBe(0);
    expect(h.createdGames).toBeNull();
  });

  it("réécrit les jeux dès qu'un jeu se termine", async () => {
    h.match = freshMatch({ games: [{ pointsHome: 11, pointsAway: 5 }] });
    await PUT(put({ games: [{ home: 11, away: 5 }, { home: 9, away: 11 }] }), ctx);
    expect(h.deleteCalls).toBe(1);
    expect(h.createdGames).toHaveLength(2);
  });

  it("clôt le match, libère la prise et efface l'instantané", async () => {
    const games = [{ home: 11, away: 5 }, { home: 11, away: 8 }, { home: 11, away: 9 }];
    const res = await PUT(put({ games, live: liveSnap }), ctx);
    expect((await res.json()).done).toBe(true);
    expect(h.updated).toMatchObject({
      status: "done",
      scorerId: null,
      scorerClaimedAt: null,
      liveJson: null,
      gamesHome: 3,
      gamesAway: 0,
    });
  });

  it("refuse un score impossible", async () => {
    expect((await PUT(put({ games: [{ home: 12, away: 0 }] }), ctx)).status).toBe(400);
  });

  it("refuse d'écrire si quelqu'un d'autre marque activement", async () => {
    h.match = freshMatch({ scorerId: "u2", scorerClaimedAt: RECENT, updatedAt: RECENT });
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(409);
  });

  it("reprend en silence une prise abandonnée : le match continue sur un autre téléphone", async () => {
    h.match = freshMatch({ scorerId: "u2", scorerClaimedAt: OLD, updatedAt: OLD });
    const res = await PUT(put({ games: [], live: liveSnap }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated).toMatchObject({ scorerId: "u1" });
  });

  it("est idempotent : renvoyer le même état ne change rien", async () => {
    h.match = freshMatch({ games: [{ pointsHome: 11, pointsAway: 5 }] });
    const body = { games: [{ home: 11, away: 5 }], live: liveSnap };
    await PUT(put(body), ctx);
    const first = { ...h.updated };
    h.updated = null;
    await PUT(put(body), ctx);
    expect(h.updated).toMatchObject({
      gamesHome: first.gamesHome as number,
      gamesAway: first.gamesAway as number,
      status: first.status as string,
    });
    expect(h.deleteCalls).toBe(0);
  });
});
