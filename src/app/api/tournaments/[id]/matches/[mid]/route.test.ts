import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

type View = {
  isParticipant: boolean;
  isCreator: boolean;
  players: { id: string }[];
  pools: { matches: Record<string, unknown>[] }[] | null;
  bracket: { matches: Record<string, unknown>[] } | null;
  status: string;
};

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  tournament: null as null | Record<string, unknown>,
  view: {} as View,
  matchUpdate: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
  matchUpdateMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
  tournamentUpdate: vi.fn(async (_args: unknown) => ({})),
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_TOURNAMENT() {
    return h.featureOn;
  },
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    // Exécute la callback de transaction avec un faux tx (propage les throws → catch route).
    $transaction: (fn: (tx: unknown) => unknown) =>
      Promise.resolve(
        fn({
          tournament: { findUnique: async () => h.tournament, update: h.tournamentUpdate },
          match: { update: h.matchUpdate, updateMany: h.matchUpdateMany },
        }),
      ),
  },
}));
// On garde validScore/tournamentInclude RÉELS ; on ne contrôle que serializeTournament.
vi.mock("@/lib/tournament-db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tournament-db")>("@/lib/tournament-db");
  return { ...actual, serializeTournament: () => h.view };
});

import { PATCH } from "./route";

const req = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const params = Promise.resolve({ id: "t1", mid: "m1" });

// Vue « poule » par défaut : 1 match jouable m1 entre p1 et p2, l'utilisateur est participant.
function poolView(over: Partial<View> = {}, match: Record<string, unknown> = {}): View {
  return {
    isParticipant: true,
    isCreator: false,
    players: [{ id: "p1" }, { id: "p2" }],
    pools: [
      {
        matches: [
          { id: "m1", p1: { id: "p1" }, p2: { id: "p2" }, status: "pending", winnerId: null, ...match },
        ],
      },
    ],
    bracket: null,
    status: "running",
    ...over,
  };
}

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.tournament = { bestOf: 3, status: "running", matches: [] };
  h.view = poolView();
  h.matchUpdate.mockClear();
  h.matchUpdateMany.mockClear();
  h.tournamentUpdate.mockClear();
});

describe("PATCH /api/tournaments/[id]/matches/[mid]", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(401);
  });

  it("400 si le score n'est pas numérique", async () => {
    const res = await PATCH(req({ score1: "2", score2: 0 }), { params });
    expect(res.status).toBe(400);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("403 si l'utilisateur n'est ni participant ni créateur", async () => {
    h.view = poolView({ isParticipant: false, isCreator: false });
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(403);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("400 si le score est illégal pour le format (2-2 en bo3)", async () => {
    const res = await PATCH(req({ score1: 2, score2: 2 }), { params });
    expect(res.status).toBe(400);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("404 si le match est introuvable dans la vue", async () => {
    h.view = poolView({ pools: [{ matches: [] }] });
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(404);
  });

  it("400 sur un match « bye »", async () => {
    h.view = poolView({}, { status: "bye" });
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(400);
  });

  it("409 si le match est déjà saisi et que l'utilisateur n'est pas le créateur", async () => {
    h.view = poolView({}, { status: "done", winnerId: "p1" });
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(409);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("enregistre un score valide (participant) : winnerId = camp gagnant", async () => {
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdate).toHaveBeenCalledTimes(1);
    const arg = h.matchUpdate.mock.calls[0][0];
    expect(arg.where.id).toBe("m1");
    expect(arg.data).toMatchObject({ winnerId: "p1", status: "done" });
  });

  it("le créateur peut corriger un match déjà saisi", async () => {
    h.view = poolView({ isCreator: true }, { status: "done", winnerId: "p1" });
    const res = await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdate).toHaveBeenCalledTimes(1);
  });
});
