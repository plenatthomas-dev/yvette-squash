import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Connexion « email seul » : l'anti-brute-force ne doit pas se laisser remettre à zéro, et
// aucune entrée démesurée ne doit atteindre scrypt (route anonyme, coût proportionnel).

const h = vi.hoisted(() => ({
  count: vi.fn(async (_args: unknown) => 0),
  create: vi.fn(async (_args: unknown) => ({})),
  deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 })),
  findUser: vi.fn(),
  verifyPassword: vi.fn(async (_pw: string, _hash: string) => true),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    loginAttempt: { count: h.count, create: h.create, deleteMany: h.deleteMany },
    user: { findUnique: h.findUser },
  },
}));
vi.mock("@/lib/crypto", () => ({
  hashPassword: async () => "leurre",
  verifyPassword: h.verifyPassword,
}));
vi.mock("@/lib/session", () => ({
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
  createEmailSession: vi.fn(async () => "sid"),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ emailLogin: true }) }));
vi.mock("@/lib/app-block", () => ({ appBlockForEmail: async () => null, appBlockedResponse: vi.fn() }));
vi.mock("@/lib/email-auth", () => ({
  EMAIL_RE: /^(?=.{1,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/,
  MAX_PASSWORD_LEN: 200,
  clientIp: () => "1.2.3.4",
}));

import { POST } from "./route";

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.findUser.mockResolvedValue({
    id: "u1",
    displayName: "Alice",
    passwordHash: "hash",
    emailVerifiedAt: new Date(),
    disabledAt: null,
  });
});

describe("POST /api/auth/email/login", () => {
  it("une réussite n'efface QUE les échecs du couple (IP, compte)", async () => {
    // L'ancienne forme `OR: [{ ip }, { identifier }]` effaçait les échecs de l'IP sur TOUS les
    // comptes : un attaquant muni d'un compte valide remettait la limite par IP à zéro en se
    // connectant entre deux salves.
    const res = await POST(req({ email: "Alice@Example.fr", password: "motdepasse" }));
    expect(res.status).toBe(200);
    expect(h.deleteMany.mock.calls.at(-1)?.[0].where).toEqual({
      ip: "1.2.3.4",
      identifier: "alice@example.fr",
    });
  });

  it("refuse un mot de passe démesuré (400) AVANT tout scrypt et toute lecture", async () => {
    const res = await POST(req({ email: "alice@example.fr", password: "p".repeat(201) }));
    expect(res.status).toBe(400);
    expect(h.verifyPassword).not.toHaveBeenCalled();
    expect(h.count).not.toHaveBeenCalled();
  });
});
