import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  where: null as null | Record<string, unknown>,
  count: 2,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    pushSubscription: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.where = args.where;
        return { count: h.count };
      }),
    },
  },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.session = { userId: "u1" };
  h.where = null;
  h.count = 2;
});

describe("POST /api/push/unsubscribe", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(post({}))).status).toBe(401);
  });

  it("sans endpoint, coupe TOUS les appareils du membre", async () => {
    // C'est le geste « je ne veux plus rien recevoir » : il ne doit pas dépendre de
    // l'appareil depuis lequel on le fait.
    const body = await (await POST(post({}))).json();
    expect(h.where).toEqual({ userId: "u1" });
    expect(body.removed).toBe(2);
  });

  it("avec un endpoint, ne coupe que cet appareil-là", async () => {
    await POST(post({ endpoint: "https://push.example/abc" }));
    expect(h.where).toEqual({ userId: "u1", endpoint: "https://push.example/abc" });
  });

  it("ne retire jamais l'abonnement de quelqu'un d'autre", async () => {
    await POST(post({ endpoint: "https://push.example/abc" }));
    expect((h.where as { userId: string }).userId).toBe("u1");
  });

  it("un endpoint vide vaut « tous mes appareils », pas une requête sans filtre", async () => {
    await POST(post({ endpoint: "" }));
    expect(h.where).toEqual({ userId: "u1" });
  });
});
