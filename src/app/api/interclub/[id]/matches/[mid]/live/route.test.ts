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
  fixtureUpdate: null as null | Record<string, unknown>,
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
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.fixtureStatus = args.data.status as string;
        h.fixtureUpdate = args.data;
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

// Une rencontre déjà en cours a forcément vu partir son « la rencontre commence » : le marqueur
// de début est donc posé, celui de fin ne l'est pas.
const NOTIFIED = new Date(Date.now() - 20 * 60_000);

const baseFixture = {
  id: "f1",
  bestOf: 5,
  matchCount: 4,
  status: "live",
  startNotifiedAt: NOTIFIED,
  doneNotifiedAt: null as Date | null,
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
  h.fixtureUpdate = null;
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
    // Le marqueur annule le point décisif : la liste RÉTRÉCIT, ce qui exige d'annoncer la base
    // (cf. « fraîcheur du journal » plus bas) — l'écran de marquage le fait à chaque envoi.
    h.match = freshMatch({ status: "done", scorerId: "u1", games: asRows(WIN) });
    const res = await PUT(put({ games: WIN.slice(0, 2), knownGameCount: 3 }), ctx);
    expect(res.status).toBe(200);
  });
});

// --- Garde de fraîcheur ----------------------------------------------------
//
// Le scénario, sans concurrence ni malveillance : le marqueur compte deux jeux, fait « Retour »
// (la prise est relâchée, son journal local RESTE) ; un capitaine saisit le 3ᵉ jeu a posteriori ;
// le marqueur rouvre le marquage, son journal l'emporte à l'amorçage, et le premier point tapé
// renvoyait deux jeux là où la base en avait trois. `games` remplaçant tout, le 3ᵉ disparaissait.
describe("PUT .../live — fraîcheur du journal", () => {
  it("refuse un journal bâti sur un état que la base a dépassé", async () => {
    h.match = freshMatch({ scorerId: null, games: asRows(WIN.slice(0, 3)) });
    const res = await PUT(put({ games: WIN.slice(0, 2), knownGameCount: 2 }), ctx);
    expect(res.status).toBe(409);
    // Le code, et non le message : c'est là-dessus que le marqueur branche sa reprise.
    expect((await res.json()).code).toBe("stale-games");
    expect(h.deleteCalls).toBe(0);
    expect(h.updated).toBeNull();
  });

  it("laisse passer un undo, qui raccourcit les jeux ENVOYÉS et non l'état connu", async () => {
    h.match = freshMatch({ games: asRows(WIN.slice(0, 2)) });
    const res = await PUT(put({ games: WIN.slice(0, 1), knownGameCount: 2 }), ctx);
    expect(res.status).toBe(200);
  });

  it("reste facultatif tant que la liste ne RÉTRÉCIT pas", async () => {
    h.match = freshMatch({ games: asRows(WIN.slice(0, 1)) });
    expect((await PUT(put({ games: WIN.slice(0, 2) }), ctx)).status).toBe(200);
  });

  it("refuse d'effacer des jeux sans dire sur quel score on se fonde", async () => {
    // Le corps minimal : n'importe quel membre pouvait le poster sur un match que personne ne
    // tient, et il remettait le simple à `pending` en supprimant toutes ses lignes.
    h.match = freshMatch({ scorerId: null, games: asRows(WIN) });
    const res = await PUT(put({ games: [], live: null }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("stale-games");
    expect(h.deleteCalls).toBe(0);
    expect(h.updated).toBeNull();
  });

  it("refuse un knownGameCount aberrant", async () => {
    expect((await PUT(put({ games: [], knownGameCount: -1 }), ctx)).status).toBe(400);
    expect((await PUT(put({ games: [], knownGameCount: "deux" }), ctx)).status).toBe(400);
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
  it("annonce le début quand la rencontre bascule en direct, et pose le marqueur", async () => {
    h.match = freshMatch({
      status: "pending",
      interclub: { ...baseFixture, status: "scheduled", startNotifiedAt: null },
    });
    h.siblings = [{ gamesHome: 1, gamesAway: 0, status: "live", homeDisplayName: "Tom" }];
    await PUT(put({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.notified).toContain("fixtureStart");
    // Le marqueur est écrit DANS la même transaction que le statut : c'est lui, et non le
    // statut, qui empêchera la seconde annonce.
    expect(h.fixtureUpdate?.startNotifiedAt).toBeInstanceOf(Date);
  });

  it("ne réannonce pas le début d'une rencontre revenue de `done` à `live`", async () => {
    // Le geste : le créateur vide les jeux d'un simple pour ressaisir le bon score. La
    // rencontre redescend alors de `done` à `live` — ce qui, comparé au statut STOCKÉ,
    // ressemblait trait pour trait à un début de rencontre.
    h.match = freshMatch({
      status: "pending",
      interclub: {
        ...baseFixture,
        status: "done",
        startNotifiedAt: NOTIFIED,
        doneNotifiedAt: NOTIFIED,
      },
    });
    h.siblings = [{ gamesHome: 1, gamesAway: 0, status: "live", homeDisplayName: "Tom" }];
    await PUT(put({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.notified).not.toContain("fixtureStart");
    expect(h.fixtureUpdate?.startNotifiedAt).toBeUndefined();
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
    h.match = freshMatch({
      status: "done",
      games: asRows(WIN),
      interclub: { ...baseFixture, status: "done", doneNotifiedAt: NOTIFIED },
    });
    await PUT(put({ games: WIN }), ctx);
    expect(h.notified).not.toContain("fixtureDone");
  });

  it("ne réannonce pas le résultat après une correction en deux temps", async () => {
    // Vider puis ressaisir : la rencontre repasse par `live` avant de revenir à `done`. Une
    // garde comparant le statut stocké voyait alors une transition neuve et renvoyait le
    // résultat final à tous les abonnés. Le marqueur, lui, est déjà posé.
    h.siblings = Array.from({ length: 4 }, () => ({
      gamesHome: 3,
      gamesAway: 0,
      status: "done",
      homeDisplayName: "Tom",
    }));
    h.match = freshMatch({
      status: "live",
      interclub: { ...baseFixture, status: "live", doneNotifiedAt: NOTIFIED },
    });
    await PUT(put({ games: WIN }), ctx);
    expect(h.fixtureStatus).toBe("done");
    expect(h.notified).not.toContain("fixtureDone");
  });
});
