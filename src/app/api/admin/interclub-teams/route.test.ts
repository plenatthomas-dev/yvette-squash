import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  admin: null as null | { userId: string; email: string },
  teams: [] as Array<{ id: string }>,
  orphans: [] as Array<{ id: string }>,
  updates: [] as Array<{ id: string; teamId: string | null }>,
  cleared: 0,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: { findMany: vi.fn(async () => h.teams) },
    user: {
      findMany: vi.fn(async () => h.orphans),
      update: vi.fn(async (args: { where: { id: string }; data: { teamId: string | null } }) => {
        h.updates.push({ id: args.where.id, teamId: args.data.teamId });
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: h.cleared })),
    },
  },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.interclub = true;
  h.admin = { userId: "u1", email: "admin@example.com" };
  h.teams = [{ id: "t1" }, { id: "t2" }];
  h.orphans = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  h.updates = [];
  h.cleared = 0;
});

describe("POST /api/admin/interclub-teams", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await POST(post({ mode: "fill" }))).status).toBe(404);
  });

  it("403 si on n'est pas admin", async () => {
    h.admin = null;
    expect((await POST(post({ mode: "fill" }))).status).toBe(403);
  });

  it("répartit en alternant, pour un résultat équilibré et reproductible", async () => {
    const res = await POST(post({ mode: "fill" }));
    expect(res.status).toBe(200);
    expect(h.updates.map((u) => u.teamId)).toEqual(["t1", "t2", "t1", "t2", "t1"]);
  });

  it("ne touche qu'aux membres sans équipe — la requête les filtre déjà", async () => {
    h.orphans = [];
    const body = await (await POST(post({ mode: "fill" }))).json();
    expect(body.assigned).toBe(0);
    expect(h.updates).toEqual([]);
  });

  it("refuse de répartir s'il n'y a aucune équipe", async () => {
    h.teams = [];
    expect((await POST(post({ mode: "fill" }))).status).toBe(400);
  });

  it("sait tout remettre à zéro", async () => {
    h.cleared = 7;
    const body = await (await POST(post({ mode: "clear" }))).json();
    expect(body.cleared).toBe(7);
  });

  it("refuse un mode inconnu plutôt que d'agir au hasard", async () => {
    expect((await POST(post({ mode: "shuffle" }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
  });
});
