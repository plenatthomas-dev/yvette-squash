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
  fixtureStatus: null as null | string,
  notified: [] as string[],
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
// Les notifications sont mockées ICI, et non laissées au hasard : sans ce mock, le module réel
// s'exécutait, tombait sur un `prisma.interclubFollow` absent, et son try/catch best-effort
// avalait l'erreur — aucune des quatre transitions n'était réellement observée.
vi.mock("@/lib/interclub-notify", () => ({
  notifyFixtureStart: vi.fn(async () => {
    h.notified.push("fixtureStart");
  }),
  notifyGameDone: vi.fn(async () => {
    h.notified.push("gameDone");
  }),
  notifyMatchDone: vi.fn(async () => {
    h.notified.push("matchDone");
  }),
  notifyFixtureDone: vi.fn(async () => {
    h.notified.push("fixtureDone");
  }),
}));
vi.mock("@/lib/db", () => {
  const tx = {
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
    interclub: {
      update: vi.fn(async (args: { data: { status: string } }) => {
        h.fixtureStatus = args.data.status;
        return {};
      }),
    },
  };
  return {
    prisma: { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) },
  };
});

import { PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "f1", mid: "m1" }) };
const put = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

const RECENT = new Date(Date.now() - 30_000);
const OLD = new Date(Date.now() - 60 * 60_000);

const liveSnap = {
  current: { home: 7, away: 4 },
  serving: "home",
  servingBox: "left",
  awaitingServeBox: false,
};
const WIN = [
  { home: 11, away: 5 },
  { home: 11, away: 8 },
  { home: 11, away: 9 },
];
const asRows = (games: { home: number; away: number }[]) =>
  games.map((g) => ({ pointsHome: g.home, pointsAway: g.away }));

const baseFixture = {
  id: "f1",
  bestOf: 5,
  matchCount: 4,
  status: "live",
  opponent: "Massy",
  teamId: "team-1",
  team: { name: "Équipe 1" },
};

const freshMatch = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  interclubId: "f1",
  scorerId: "u1",
  scorerClaimedAt: RECENT,
  updatedAt: RECENT,
  status: "live",
  games: [] as Array<{ pointsHome: number; pointsAway: number }>,
  homeDisplayName: "Tom",
  awayName: "Gégé",
  interclub: baseFixture,
  ...over,
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.match = freshMatch();
  h.siblings = [{ gamesHome: null, gamesAway: null, status: "live", homeDisplayName: "Tom" }];
  h.updated = null;
  h.createdGames = null;
  h.deleteCalls = 0;
  h.fixtureStatus = null;
  h.notified = [];
});

describe("PUT .../live — gardes", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(401);
  });

  it("404 si le match appartient à une autre rencontre", async () => {
    h.match = freshMatch({ interclubId: "AUTRE" });
    expect((await PUT(put({ games: [] }), ctx)).status).toBe(404);
  });

  it("refuse un corps sans liste de jeux", async () => {
    expect((await PUT(put({}), ctx)).status).toBe(400);
  });

  it("refuse un instantané qui n'en est pas un", async () => {
    const absurde = { current: { home: -1, away: 0 } };
    expect((await PUT(put({ games: [], live: absurde }), ctx)).status).toBe(400);
    expect((await PUT(put({ games: [], live: "bonjour" }), ctx)).status).toBe(400);
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

  it("un tiers ne peut PAS réécrire le score d'un match terminé", async () => {
    // Sans cette garde, n'importe quel membre inversait un 3-0 en 0-3 : un match terminé n'a
    // plus de prise « fraîche », donc le contrôle de marqueur le laissait passer.
    h.match = freshMatch({ status: "done", scorerId: "u2", scorerClaimedAt: OLD, updatedAt: OLD });
    h.session = { userId: "intrus" };
    expect((await PUT(put({ games: [{ home: 0, away: 11 }] }), ctx)).status).toBe(409);
  });

  it("mais celui qui marquait peut revenir sur sa saisie", async () => {
    h.match = freshMatch({ status: "done", scorerId: "u1", games: asRows(WIN) });
    expect((await PUT(put({ games: WIN.slice(0, 2) }), ctx)).status).toBe(200);
  });
});

describe("PUT .../live — écritures", () => {
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

  it("clôt le match, efface l'instantané, mais GARDE la prise pour permettre l'annulation", async () => {
    const res = await PUT(put({ games: WIN, live: liveSnap }), ctx);
    expect((await res.json()).done).toBe(true);
    expect(h.updated).toMatchObject({
      status: "done",
      liveJson: null,
      gamesHome: 3,
      gamesAway: 0,
      scorerId: "u1",
    });
  });

  it("recale le statut de la rencontre", async () => {
    h.siblings = Array.from({ length: 4 }, () => ({
      gamesHome: 3,
      gamesAway: 0,
      status: "done",
      homeDisplayName: "Tom",
    }));
    await PUT(put({ games: WIN }), ctx);
    expect(h.fixtureStatus).toBe("done");
  });
});

describe("PUT .../live — notifications, sur les transitions seulement", () => {
  it("annonce le début quand la rencontre bascule en direct", async () => {
    h.match = freshMatch({ status: "pending", interclub: { ...baseFixture, status: "scheduled" } });
    h.siblings = [{ gamesHome: 1, gamesAway: 0, status: "live", homeDisplayName: "Tom" }];
    await PUT(put({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.notified).toContain("fixtureStart");
  });

  it("annonce un jeu terminé", async () => {
    await PUT(put({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.notified).toEqual(["gameDone"]);
  });

  it("annonce la victoire UNE seule fois, même si le marqueur renvoie le même état", async () => {
    // La reprise après coupure renvoie l'état COMPLET : sans garde de transition, chaque
    // renvoi réannonçait la victoire à tous les abonnés.
    await PUT(put({ games: WIN }), ctx);
    expect(h.notified).toContain("matchDone");

    h.notified = [];
    h.match = freshMatch({ status: "done", games: asRows(WIN) });
    await PUT(put({ games: WIN }), ctx);
    expect(h.notified).toEqual([]);
  });

  it("n'annonce pas la fin de rencontre une seconde fois", async () => {
    h.siblings = Array.from({ length: 4 }, () => ({
      gamesHome: 3,
      gamesAway: 0,
      status: "done",
      homeDisplayName: "Tom",
    }));
    h.match = freshMatch({ status: "done", games: asRows(WIN), interclub: { ...baseFixture, status: "done" } });
    await PUT(put({ games: WIN }), ctx);
    expect(h.notified).not.toContain("fixtureDone");
  });
});
