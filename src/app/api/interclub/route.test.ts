import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// État mutable partagé, hoisté pour être visible des factories vi.mock (hoistées en tête).
const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  teams: [] as Array<Record<string, unknown>>,
  team: null as null | Record<string, unknown>,
  users: [] as Array<Record<string, unknown>>,
  fixtures: [] as Array<Record<string, unknown>>,
  created: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      findUnique: vi.fn(async () => h.team),
    },
    interclub: {
      findMany: vi.fn(async () => h.fixtures),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created = args.data;
        return { id: "f1" };
      }),
    },
    user: { findMany: vi.fn(async () => h.users) },
  },
}));

import { GET, POST } from "./route";

const req = () =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams() },
  }) as unknown as NextRequest;

const post = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
  }) as unknown as NextRequest;

const validBody = {
  date: "2026-09-03",
  teamId: "t1",
  opponent: "Squash de Massy",
};

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.teams = [{ id: "t1", name: "Équipe 1" }];
  h.team = { id: "t1", name: "Équipe 1" };
  h.users = [];
  h.fixtures = [];
  h.created = null;
});

describe("GET /api/interclub", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie les équipes et les rencontres avec leur score", async () => {
    h.fixtures = [
      {
        id: "f1",
        date: "2026-09-03",
        team: { id: "t1", name: "Équipe 1" },
        opponent: "Massy",
        home: true,
        division: "D2",
        matchCount: 4,
        matches: [
          { gamesHome: 3, gamesAway: 0, status: "done" },
          { gamesHome: 1, gamesAway: 3, status: "done" },
          { gamesHome: null, gamesAway: null, status: "pending" },
          { gamesHome: null, gamesAway: null, status: "pending" },
        ],
      },
    ];
    const body = await (await GET(req())).json();
    expect(body.teams).toHaveLength(1);
    expect(body.fixtures[0].score).toEqual({ home: 1, away: 1 });
    // Deux matchs sur quatre saisis ⇒ la rencontre est en cours, pas terminée.
    expect(body.fixtures[0].status).toBe("live");
  });
});

describe("POST /api/interclub", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await POST(post(validBody))).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it("tout membre connecté peut créer une rencontre (aucun rôle exigé)", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(201);
    expect(h.created?.createdById).toBe("u1");
  });

  it("crée autant de simples que demandé, numérotés dans l'ordre", async () => {
    await POST(post({ ...validBody, matchCount: 4 }));
    const create = (h.created?.matches as { create: Array<{ order: number }> }).create;
    expect(create).toHaveLength(4);
    expect(create.map((m) => m.order)).toEqual([1, 2, 3, 4]);
  });

  it("fige le nom du membre aligné, pour survivre à une suppression de compte", async () => {
    h.users = [{ id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé" }];
    await POST(post({ ...validBody, matches: [{ userId: "u9", awayName: "Dupont" }] }));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeDisplayName).toBe("Jéjé");
    expect(create[0].homeUserId).toBe("u9");
    expect(create[0].awayName).toBe("Dupont");
  });

  it("laisse la composition ouverte quand elle n'est pas fournie", async () => {
    await POST(post(validBody));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeDisplayName).toBe("À désigner");
    expect(create[0].homeUserId).toBeNull();
  });

  it("refuse une date mal formée", async () => {
    expect((await POST(post({ ...validBody, date: "03/09/2026" }))).status).toBe(400);
  });

  it("refuse un club adverse vide", async () => {
    expect((await POST(post({ ...validBody, opponent: "   " }))).status).toBe(400);
  });

  it("refuse une équipe inconnue", async () => {
    h.team = null;
    expect((await POST(post(validBody))).status).toBe(400);
  });

  it("refuse un format autre que le meilleur des 3 ou des 5", async () => {
    expect((await POST(post({ ...validBody, bestOf: 4 }))).status).toBe(400);
  });

  it("refuse un nombre de matchs hors bornes", async () => {
    expect((await POST(post({ ...validBody, matchCount: 0 }))).status).toBe(400);
    expect((await POST(post({ ...validBody, matchCount: 99 }))).status).toBe(400);
  });

  it("refuse d'aligner deux fois le même membre", async () => {
    h.users = [{ id: "u9", displayName: "Jérôme", nickname: null }];
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }, { userId: "u9" }] }));
    expect(res.status).toBe(400);
  });

  it("refuse une couleur hors palette : le contraste ne serait plus garanti", async () => {
    const res = await POST(post({ ...validBody, matches: [{ name: "Tom", homeColor: "turquoise" }] }));
    expect(res.status).toBe(400);
  });

  it("refuse plus de joueurs que de matchs", async () => {
    const res = await POST(
      post({ ...validBody, matchCount: 1, matches: [{ name: "A" }, { name: "B" }] }),
    );
    expect(res.status).toBe(400);
  });
});
