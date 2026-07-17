import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Vérifie la cérémonie de connexion par passkey : gating par flag, anti-abus (429), défi à
// USAGE UNIQUE (cookie toujours effacé), credential inconnu/désactivé, échec de vérification, et
// l'échelle de session (ResaMania → email → mur 409). Toutes les frontières sont mockées.
const h = vi.hoisted(() => ({
  emailLogin: true,
  rateLimited: false,
  challenge: { challenge: "chal", type: "auth" } as null | { challenge: string; type: string },
  passkey: null as null | Record<string, unknown>,
  verifyResult: { verified: true, authenticationInfo: { newCounter: 5 } } as unknown,
  verifyThrows: false,
  resaSid: "resa-sid" as string | null,
  emailSid: null as string | null,
  passkeyUpdate: vi.fn(),
  recordAttempt: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  verifyAuthenticationResponse: vi.fn(async () => {
    if (h.verifyThrows) throw new Error("counter regression");
    return h.verifyResult;
  }),
}));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ emailLogin: h.emailLogin }),
}));
vi.mock("@/lib/client-ip", () => ({ clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/session", () => ({
  createResaSessionFromUser: vi.fn(async () => h.resaSid),
  createEmailSession: vi.fn(async () => h.emailSid),
}));
vi.mock("@/lib/webauthn", () => ({
  rpParams: () => ({ rpID: "localhost", origin: "http://localhost" }),
  openChallenge: () => h.challenge,
  passkeyRateLimited: async () => h.rateLimited,
  recordPasskeyAttempt: h.recordAttempt,
  CHALLENGE_COOKIE: "wa_chal",
  challengeCookieOptions: () => ({ path: "/" }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    passkey: {
      findUnique: vi.fn(async () => h.passkey),
      update: h.passkeyUpdate,
    },
  },
}));

import { POST } from "./route";

const postReq = (body: unknown) =>
  ({
    headers: { get: () => null },
    cookies: { get: (n: string) => (n === "wa_chal" ? { value: "sealed" } : undefined) },
    json: async () => body,
  }) as unknown as NextRequest;

const goodBody = { response: { id: "cred1" } };
const clears = (res: { cookies: { get: (n: string) => { value: string } | undefined } }) =>
  res.cookies.get("wa_chal")?.value === "";

beforeEach(() => {
  h.emailLogin = true;
  h.rateLimited = false;
  h.challenge = { challenge: "chal", type: "auth" };
  h.passkey = {
    id: "pk1",
    userId: "u1",
    credentialId: "cred1",
    publicKey: Buffer.from([1, 2, 3]),
    counter: 0,
    transports: "internal",
    user: {
      id: "u1",
      displayName: "Jean",
      disabledAt: null,
      passwordHash: "hash",
      emailVerifiedAt: new Date(),
    },
  };
  h.verifyResult = { verified: true, authenticationInfo: { newCounter: 5 } };
  h.verifyThrows = false;
  h.resaSid = "resa-sid";
  h.emailSid = null;
  h.passkeyUpdate.mockReset().mockResolvedValue({});
  h.recordAttempt.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/auth/webauthn/auth/verify", () => {
  it("404 si la connexion e-mail est désactivée", async () => {
    h.emailLogin = false;
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(404);
  });

  it("429 si trop de tentatives (rate-limit IP)", async () => {
    h.rateLimited = true;
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(429);
    expect(clears(res)).toBe(true); // le défi est effacé même sur un refus anti-abus
  });

  it("400 si la réponse d'authentification est absente", async () => {
    expect((await POST(postReq({}))).status).toBe(400);
  });

  it("400 si le défi est expiré/absent", async () => {
    h.challenge = null;
    expect((await POST(postReq(goodBody))).status).toBe(400);
  });

  it("401 + tentative comptée si le credential est inconnu", async () => {
    h.passkey = null;
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(401);
    expect(h.recordAttempt).toHaveBeenCalled();
    expect(clears(res)).toBe(true);
  });

  it("403 si le compte est désactivé", async () => {
    (h.passkey!.user as Record<string, unknown>).disabledAt = new Date();
    expect((await POST(postReq(goodBody))).status).toBe(403);
  });

  it("401 + tentative comptée si la vérification lève (ex. régression de compteur)", async () => {
    h.verifyThrows = true;
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(401);
    expect(h.recordAttempt).toHaveBeenCalled();
    expect(clears(res)).toBe(true);
  });

  it("401 si l'assertion n'est pas vérifiée", async () => {
    h.verifyResult = { verified: false };
    expect((await POST(postReq(goodBody))).status).toBe(401);
  });

  it("succès : met à jour le compteur, ouvre la session ResaMania et efface le défi", async () => {
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect(h.passkeyUpdate).toHaveBeenCalledWith({
      where: { id: "pk1" },
      data: { counter: 5, lastUsedAt: expect.any(Date) },
    });
    expect(res.cookies.get("sid")?.value).toBe("resa-sid");
    expect(clears(res)).toBe(true); // défi à usage unique
  });

  it("repli session e-mail si la session ResaMania ne peut pas être restaurée", async () => {
    h.resaSid = null;
    h.emailSid = "email-sid";
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sid")?.value).toBe("email-sid");
  });

  it("409 si biométrie OK mais aucune session possible (ResaMania morte, pas d'e-mail)", async () => {
    h.resaSid = null;
    h.emailSid = null;
    (h.passkey!.user as Record<string, unknown>).passwordHash = null;
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(409);
    expect(clears(res)).toBe(true);
  });
});
