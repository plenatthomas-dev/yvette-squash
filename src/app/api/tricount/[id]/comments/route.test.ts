import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Garde-fou anti-emballement : le fil de discussion n'avait aucune limite, un client qui boucle
// (ou un compte compromis) pouvait remplir la base. Volontairement large — une vraie
// conversation ne l'atteint jamais.

const h = vi.hoisted(() => ({
  /** Drapeau de fonction : le 404 « coupée » est le premier cas canonique. */
  tricountOn: true,
  session: { userId: "u1", displayName: "Membre", resa: null } as { userId: string } | null,
  recentCount: 0,
  create: vi.fn(async () => ({ id: "c1" })),
  count: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: h.tricountOn,
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
  h.tricountOn = true;
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

describe("POST /api/tricount/[id]/comments — cas canoniques et bornes chiffrées", () => {
  it("répond 404 quand la fonction est coupée", async () => {
    h.tricountOn = false;
    const res = await POST(req("Salut"), ctx);
    expect(res.status).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    const res = await POST(req("Salut"), ctx);
    expect(res.status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuse un message de plus de 500 caractères", async () => {
    const res = await POST(req("x".repeat(501)), ctx);
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("compte sur une fenêtre de DIX MINUTES, pas sur une durée quelconque", async () => {
    // L'assertion précédente se contentait de `toBeInstanceOf(Date)` : `WINDOW_MS = 10` (dix
    // millisecondes) ou `10 * 86_400_000` (dix jours) l'auraient satisfaite tout autant. Une
    // borne qu'aucun test ne calcule ne borne rien.
    const avant = Date.now();
    await POST(req("Salut"), ctx);
    const where = h.count.mock.calls[0][0].where as { createdAt: { gte: Date } };
    const fenetre = avant - where.createdAt.gte.getTime();
    expect(fenetre).toBeGreaterThanOrEqual(10 * 60_000 - 50);
    expect(fenetre).toBeLessThanOrEqual(10 * 60_000 + 50);
  });

  it("laisse passer le 29ᵉ message et refuse le 30ᵉ — la frontière, pas seulement le milieu", async () => {
    h.recentCount = 29;
    expect((await POST(req("Salut"), ctx)).status).toBe(201);
    h.recentCount = 30;
    expect((await POST(req("Salut"), ctx)).status).toBe(429);
  });
});
