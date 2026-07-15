import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Garde-fou anti-emballement : le fil de discussion n'avait aucune limite, un client qui boucle
// (ou un compte compromis) pouvait remplir la base. Volontairement large — une vraie
// conversation ne l'atteint jamais.

const h = vi.hoisted(() => ({
  session: { userId: "u1", displayName: "Membre", resa: null } as { userId: string } | null,
  recentCount: 0,
  create: vi.fn(async () => ({ id: "c1" })),
  count: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: true,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    tricount: { findUnique: vi.fn(async () => ({ id: "t1" })) },
    tricountComment: { create: h.create, count: h.count },
  },
}));

import { POST } from "./route";

const req = (body = "coucou") =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ body }),
  }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u1" };
  h.count.mockImplementation(async () => h.recentCount);
  h.recentCount = 0;
});

describe("POST /api/tricount/[id]/comments — garde-fou", () => {
  it("laisse passer une conversation normale", async () => {
    h.recentCount = 5;
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("refuse en 429 au-delà de la limite, sans rien écrire", async () => {
    h.recentCount = 30;
    const res = await POST(req(), ctx);
    expect(res.status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("compte les messages du MEMBRE, tous fils confondus (sinon on change de fil et on contourne)", async () => {
    await POST(req(), ctx);
    const where = h.count.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.tricountId).toBeUndefined();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("un message vide reste refusé avant même de compter", async () => {
    const res = await POST(req("   "), ctx);
    expect(res.status).toBe(400);
    expect(h.count).not.toHaveBeenCalled();
  });
});
