import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  rows: [] as Array<Record<string, unknown>>,
  updated: null as null | Record<string, unknown>,
  take: 0,
  deleted: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    appNotification: {
      findMany: vi.fn(async (args: { take: number }) => {
        h.take = args.take;
        return h.rows;
      }),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        h.updated = args;
        return { count: 3 };
      }),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.deleted = args.where;
        return { count: 7 };
      }),
    },
  },
}));

import { GET, POST, DELETE } from "./route";

const req = (scope?: string) =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams(scope ? { scope } : {}) },
  }) as unknown as NextRequest;
const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  title: "Équipe 1 – Massy",
  body: "Tom gagne 3-1",
  url: "/?view=interclub",
  createdAt: new Date("2026-09-03T20:00:00Z"),
  readAt: null,
  ...over,
});

beforeEach(() => {
  h.session = { userId: "u1" };
  h.rows = [];
  h.updated = null;
  h.take = 0;
  h.deleted = null;
});

describe("GET /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie la liste ET le compte de non lues en une seule requête", async () => {
    h.rows = [row(), row({ id: "n2", readAt: new Date() })];
    const body = await (await GET(req())).json();
    expect(body.items).toHaveLength(2);
    expect(body.unread).toBe(1);
    expect(body.items[0]).toMatchObject({ id: "n1", read: false });
    expect(body.items[1]).toMatchObject({ id: "n2", read: true });
  });

  it("borne la liste : une cloche n'est pas un historique", async () => {
    await GET(req());
    expect(h.take).toBe(30);
  });

  it("n'expose pas d'objet Date brut mais une chaîne ISO", async () => {
    h.rows = [row()];
    const body = await (await GET(req())).json();
    expect(typeof body.items[0].at).toBe("string");
  });
});

describe("POST /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req())).status).toBe(401);
  });

  it("ne marque comme lues que MES notifications non lues", async () => {
    await POST(req());
    expect(h.updated).toMatchObject({ where: { userId: "u1", readAt: null } });
  });
});

describe("DELETE /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await DELETE(req())).status).toBe(401);
  });

  it("sans portée, vide tout — y compris le non lu", async () => {
    const body = await (await DELETE(req())).json();
    expect(h.deleted).toEqual({ userId: "u1" });
    expect(body.removed).toBe(7);
  });

  it("avec scope=read, ne touche qu'à ce qui a déjà été vu", async () => {
    await DELETE(req("read"));
    expect(h.deleted).toEqual({ userId: "u1", readAt: { not: null } });
  });

  it("n'efface jamais les notifications d'un autre membre", async () => {
    await DELETE(req("read"));
    expect((h.deleted as { userId: string }).userId).toBe("u1");
  });
});
