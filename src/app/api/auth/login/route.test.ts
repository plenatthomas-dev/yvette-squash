import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Le rate-limit du login a DEUX dimensions. Par IP seule, un attaquant qui vise UN membre
// depuis plusieurs IP (botnet, 4G) n'est jamais freiné. Et l'IP doit venir de la source sûre :
// avec la variante naïve (1re valeur de x-forwarded-for), le compteur restait à zéro.

const h = vi.hoisted(() => ({
  ipCount: 0,
  accountCount: 0,
  count: vi.fn(),
  // Typés + renvoient des promesses : la route chaîne un `.catch()` sur create, et les tests
  // inspectent les arguments reçus.
  create: vi.fn(async (_args: { data: { ip: string; identifier: string } }) => ({})),
  deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 })),
  login: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { loginAttempt: { count: h.count, create: h.create, deleteMany: h.deleteMany } },
}));
vi.mock("@/lib/resamania/client", () => ({ login: h.login }));
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(async () => "sid"),
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
  AccountDisabledError: class extends Error {},
}));

import { POST } from "./route";

const req = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as unknown as NextRequest;

const creds = { username: "Alice@Example.COM", password: "pw" };

beforeEach(() => {
  vi.clearAllMocks();
  h.ipCount = 0;
  h.accountCount = 0;
  // count() est appelé 2× : d'abord par IP, puis par identifiant.
  h.count.mockImplementation(async (args: { where: { ip?: string } }) =>
    args.where.ip !== undefined ? h.ipCount : h.accountCount,
  );
  h.login.mockResolvedValue({ identity: { givenName: "Alice", familyName: "Martin" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/auth/login — rate limiting", () => {
  it("laisse passer une tentative normale", async () => {
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(200);
  });

  it("bloque au-delà de la limite par IP", async () => {
    h.ipCount = 5;
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(429);
    expect(h.login).not.toHaveBeenCalled(); // rien n'est transmis à ResaMania
  });

  it("bloque au-delà de la limite par COMPTE, même depuis une IP neuve", async () => {
    h.ipCount = 0; // IP jamais vue : la limite par IP ne dit rien
    h.accountCount = 10;
    const res = await POST(req(creds, { "x-real-ip": "203.0.113.99" }));
    expect(res.status).toBe(429);
    expect(h.login).not.toHaveBeenCalled();
  });

  it("compte l'identifiant NORMALISÉ (casse et espaces ignorés)", async () => {
    await POST(req({ username: "  ALICE@example.com ", password: "pw" }, { "x-real-ip": "1.2.3.4" }));
    const accountQuery = h.count.mock.calls.find((c) => c[0].where.identifier !== undefined);
    expect(accountQuery?.[0].where.identifier).toBe("alice@example.com");
  });

  it("l'IP vient de la source SÛRE, pas de la valeur forgée par le client", async () => {
    await POST(req(creds, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }));
    const ipQuery = h.count.mock.calls.find((c) => c[0].where.ip !== undefined);
    expect(ipQuery?.[0].where.ip).toBe("203.0.113.7");
    expect(ipQuery?.[0].where.ip).not.toBe("6.6.6.6");
  });

  it("un échec incrémente les DEUX compteurs", async () => {
    h.login.mockRejectedValue(new Error("bad creds"));
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(401);
    expect(h.create.mock.calls[0][0].data).toEqual({
      ip: "1.2.3.4",
      identifier: "alice@example.com",
    });
  });

  it("une réussite efface l'ardoise de l'IP ET du compte", async () => {
    await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    const cleared = h.deleteMany.mock.calls.at(-1)?.[0].where;
    expect(cleared?.OR).toEqual([{ ip: "1.2.3.4" }, { identifier: "alice@example.com" }]);
  });

  it("refuse un identifiant non textuel sans rien compter", async () => {
    const res = await POST(req({ username: { $ne: null }, password: "pw" }));
    expect(res.status).toBe(400);
    expect(h.count).not.toHaveBeenCalled();
  });
});
