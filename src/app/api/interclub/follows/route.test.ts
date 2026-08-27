import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  team: null as null | { id: string },
  rows: [] as Array<{ teamId: string; level: string }>,
  pushReady: true,
  upserted: null as null | Record<string, unknown>,
  deleted: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/push", () => ({ pushConfigured: vi.fn(() => h.pushReady) }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubFollow: {
      findMany: vi.fn(async () => h.rows),
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        h.upserted = args;
        return {};
      }),
      deleteMany: vi.fn(async (args: Record<string, unknown>) => {
        h.deleted = args;
        return { count: 1 };
      }),
    },
    interclubTeam: { findUnique: vi.fn(async () => h.team) },
  },
}));

import { GET, PUT } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const put = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.team = { id: "t1" };
  h.rows = [];
  h.pushReady = true;
  h.upserted = null;
  h.deleted = null;
});

describe("GET /api/interclub/follows", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie mes abonnements", async () => {
    h.rows = [{ teamId: "t1", level: "highlights" }];
    const body = await (await GET(req())).json();
    expect(body.follows).toEqual([{ teamId: "t1", level: "highlights" }]);
  });

  it("aucun abonnement par défaut : c'est un opt-in franc", async () => {
    const body = await (await GET(req())).json();
    expect(body.follows).toEqual([]);
  });

  it("dit si le serveur a de quoi notifier — le client ne peut pas le savoir seul", async () => {
    // NEXT_PUBLIC_VAPID_PUBLIC_KEY est inlinée au build : elle dit si la clé PUBLIQUE existait
    // à la compilation, pas si la clé privée est là à l'exécution. Seul le serveur le sait.
    expect((await (await GET(req())).json()).pushReady).toBe(true);
    h.pushReady = false;
    expect((await (await GET(req())).json()).pushReady).toBe(false);
  });
});

describe("PUT /api/interclub/follows", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PUT(put({ teamId: "t1", level: "result" }))).status).toBe(401);
  });

  it("enregistre un abonnement", async () => {
    const res = await PUT(put({ teamId: "t1", level: "detailed" }));
    expect(res.status).toBe(200);
    expect(h.upserted).toMatchObject({
      where: { userId_teamId: { userId: "u1", teamId: "t1" } },
      create: { userId: "u1", teamId: "t1", level: "detailed" },
    });
  });

  it("un niveau null retire l'abonnement", async () => {
    const res = await PUT(put({ teamId: "t1", level: null }));
    expect(res.status).toBe(200);
    expect(h.deleted).toMatchObject({ where: { userId: "u1", teamId: "t1" } });
    expect(h.upserted).toBeNull();
  });

  it("refuse un niveau inventé", async () => {
    expect((await PUT(put({ teamId: "t1", level: "tout" }))).status).toBe(400);
    expect((await PUT(put({ teamId: "t1", level: 3 }))).status).toBe(400);
  });

  it("refuse une équipe inconnue", async () => {
    h.team = null;
    expect((await PUT(put({ teamId: "fantome", level: "result" }))).status).toBe(400);
  });

  it("refuse une requête sans équipe", async () => {
    expect((await PUT(put({ level: "result" }))).status).toBe(400);
  });
});
