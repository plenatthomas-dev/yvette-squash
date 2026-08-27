import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  admin: null as null | { userId: string; email: string },
  teams: [] as Array<{ id: string }>,
  orphans: [] as Array<{ id: string }>,
  updates: [] as Array<{ id: string; teamId: string | null }>,
  writeCalls: 0,
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
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: { teamId: string | null } }) => {
          h.writeCalls += 1;
          const ids = (args.where.id as { in?: string[] } | undefined)?.in;
          if (!ids) return { count: h.cleared }; // remise à zéro
          for (const id of ids) h.updates.push({ id, teamId: args.data.teamId });
          return { count: ids.length };
        },
      ),
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
  h.writeCalls = 0;
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
    expect((await res.json()).assigned).toBe(5);
    // Trois d'un côté, deux de l'autre — et l'affectation de chacun est stable.
    const byTeam = (t: string) => h.updates.filter((u) => u.teamId === t).map((u) => u.id);
    expect(byTeam("t1")).toEqual(["a", "c", "e"]);
    expect(byTeam("t2")).toEqual(["b", "d"]);
  });

  it("écrit une fois par ÉQUIPE et non une fois par membre", async () => {
    await POST(post({ mode: "fill" }));
    // Cinq membres, deux équipes : deux écritures, pas cinq.
    expect(h.writeCalls).toBe(2);
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
