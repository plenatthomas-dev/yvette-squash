import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// /api/auth/me — la route la plus appelée de l'appli (chaque ouverture). Deux propriétés :
//  1. LA RÉPONSE NE CHANGE PAS : mêmes champs, même handle (calculé sur TOUS les membres,
//     identique à la grille), même `isAdmin`.
//  2. ELLE NE LIT PLUS L'EMAIL DES AUTRES : `isAdmin` vient de `session.email`, et la lecture
//     de tous les membres ne demande que ce que le calcul du handle exige.

const h = vi.hoisted(() => ({
  session: null as null | {
    userId: string;
    displayName: string;
    email: string | null;
    resa: unknown;
  },
  users: [] as Record<string, unknown>[],
  select: null as null | Record<string, unknown>,
  pending: vi.fn(async () => 3),
  block: vi.fn(async () => null as null | { message: string }),
  interclub: true,
  captainTeams: vi.fn(async () => [{ id: "t1", name: "Équipe 1" }]),
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (a: { select: Record<string, unknown> }) => {
        h.select = a.select;
        return h.users;
      }),
    },
  },
}));
vi.mock("@/lib/email-auth", () => ({ countPendingRequests: h.pending }));
vi.mock("@/lib/settings", () => ({ getAppBlock: h.block }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/captain-access", () => ({ captainTeams: h.captainTeams }));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "chef@example.com";
  h.interclub = true;
  h.session = { userId: "u2", displayName: "Thomas Martin", email: "thomas@example.com", resa: {} };
  h.users = [
    // Deux homonymes : le second inscrit reçoit le suffixe — c'est ce que la grille affiche.
    { id: "u1", displayName: "Thomas Martin", nickname: null, listed: true, createdAt: new Date("2025-01-01") },
    { id: "u2", displayName: "Thomas Martin", nickname: null, listed: false, createdAt: new Date("2025-02-01") },
  ];
});

describe("GET /api/auth/me", () => {
  it("401 sans session", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("rend la même réponse qu'avant : handle dé-doublonné, listed, droits", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      blocked: null,
      id: "u2",
      displayName: "Thomas Martin",
      nickname: null,
      listed: false,
      handle: expect.any(String),
      mode: "resamania",
      canBook: true,
      isAdmin: false,
      captainOf: [{ id: "t1", name: "Équipe 1" }],
      pendingRequests: 0,
    });
    // Le handle est calculé sur l'ENSEMBLE des membres : le second homonyme est suffixé.
    expect(body.handle).toMatch(/2$/);
  });

  it("ne lit PAS l'email des autres membres", async () => {
    await GET(req());
    expect(h.select).not.toHaveProperty("email");
    expect(h.select).toEqual({
      id: true,
      displayName: true,
      nickname: true,
      listed: true,
      createdAt: true,
    });
  });

  it("isAdmin vient de `session.email` : badge des demandes, et jamais bloqué", async () => {
    h.session = { ...h.session!, email: "chef@example.com" };
    h.block.mockResolvedValue({ message: "Fermé" });
    const body = await (await GET(req())).json();
    expect(body.isAdmin).toBe(true);
    expect(body.pendingRequests).toBe(3);
    expect(body.blocked).toBeNull();
    expect(h.block).not.toHaveBeenCalled();
  });

  it("un membre voit le blocage de l'appli, sans compter les demandes", async () => {
    h.block.mockResolvedValue({ message: "Fermé pour travaux" });
    const body = await (await GET(req())).json();
    expect(body.blocked).toBe("Fermé pour travaux");
    expect(h.pending).not.toHaveBeenCalled();
  });

  it("ne cherche pas de capitanat quand l'interclub est coupé", async () => {
    h.interclub = false;
    const body = await (await GET(req())).json();
    expect(body.captainOf).toEqual([]);
    expect(h.captainTeams).not.toHaveBeenCalled();
  });

  it("lance les lectures EN PARALLÈLE, et non l'une après l'autre", async () => {
    // Chaque lecture reste suspendue jusqu'à ce que TOUTES aient démarré : en séquence, la
    // première attendrait la seconde qui ne partirait jamais, et le test expirerait.
    h.session = { ...h.session!, email: "chef@example.com" };
    let demarrees = 0;
    let liberer!: () => void;
    const toutesParties = new Promise<void>((r) => (liberer = r));
    const attendre = async <T,>(v: T) => {
      if (++demarrees === 3) liberer();
      await toutesParties;
      return v;
    };
    h.pending.mockImplementationOnce(() => attendre(3));
    h.captainTeams.mockImplementationOnce(() => attendre([]));
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      attendre(h.users),
    );
    expect((await GET(req())).status).toBe(200);
    expect(demarrees).toBe(3);
  });
});
