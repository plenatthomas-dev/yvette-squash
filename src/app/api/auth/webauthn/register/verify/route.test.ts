import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Vérifie l'enrôlement d'un passkey : gating par flag, authentification requise, défi lié au
// compte, stockage de l'état de sauvegarde (backedUp / deviceType), effacement du défi à usage
// unique et idempotence sur credential déjà enrôlé. Frontières mockées.
const h = vi.hoisted(() => ({
  emailLogin: true,
  session: { userId: "u1" } as null | { userId: string },
  challenge: { challenge: "chal", type: "reg", userId: "u1" } as
    | null
    | { challenge: string; type: string; userId: string },
  verifyResult: {
    verified: true,
    registrationInfo: {
      credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialBackedUp: true,
      credentialDeviceType: "multiDevice",
    },
  } as unknown,
  verifyThrows: false,
  createThrows: false,
  passkeyCreate: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: vi.fn(async () => {
    if (h.verifyThrows) throw new Error("bad attestation");
    return h.verifyResult;
  }),
}));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ emailLogin: h.emailLogin }),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/webauthn", () => ({
  rpParams: () => ({ rpID: "localhost", origin: "http://localhost" }),
  openChallenge: () => h.challenge,
  deviceLabelFromUA: () => "iPhone · Safari",
  CHALLENGE_COOKIE: "wa_chal",
  challengeCookieOptions: () => ({ path: "/" }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    passkey: {
      create: (args: unknown) => {
        if (h.createThrows) throw new Error("unique violation");
        return h.passkeyCreate(args);
      },
    },
  },
}));

import { POST } from "./route";

const postReq = (body: unknown) =>
  ({
    headers: { get: () => "Mozilla/5.0 iPhone" },
    cookies: { get: (n: string) => (n === "wa_chal" ? { value: "sealed" } : { value: "sid" }) },
    json: async () => body,
  }) as unknown as NextRequest;

const goodBody = { response: { id: "cred1" }, deviceLabel: "Mon iPhone" };
const clears = (res: { cookies: { get: (n: string) => { value: string } | undefined } }) =>
  res.cookies.get("wa_chal")?.value === "";

beforeEach(() => {
  h.emailLogin = true;
  h.session = { userId: "u1" };
  h.challenge = { challenge: "chal", type: "reg", userId: "u1" };
  h.verifyResult = {
    verified: true,
    registrationInfo: {
      credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialBackedUp: true,
      credentialDeviceType: "multiDevice",
    },
  };
  h.verifyThrows = false;
  h.createThrows = false;
  h.passkeyCreate.mockReset().mockResolvedValue({});
});

describe("POST /api/auth/webauthn/register/verify", () => {
  it("404 si la connexion e-mail est désactivée", async () => {
    h.emailLogin = false;
    expect((await POST(postReq(goodBody))).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(postReq(goodBody))).status).toBe(401);
  });

  it("400 si la réponse d'attestation est absente", async () => {
    expect((await POST(postReq({}))).status).toBe(400);
  });

  it("400 si le défi ne correspond pas au compte connecté", async () => {
    h.challenge = { challenge: "chal", type: "reg", userId: "someone-else" };
    expect((await POST(postReq(goodBody))).status).toBe(400);
  });

  it("400 si l'attestation est invalide", async () => {
    h.verifyThrows = true;
    expect((await POST(postReq(goodBody))).status).toBe(400);
  });

  it("succès : enregistre le passkey avec l'état de sauvegarde et efface le défi", async () => {
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect(h.passkeyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u1",
        credentialId: "cred1",
        deviceLabel: "Mon iPhone",
        backedUp: true,
        deviceType: "multiDevice",
      }),
    });
    expect(clears(res)).toBe(true); // défi à usage unique
  });

  it("libellé déduit du User-Agent si non fourni", async () => {
    await POST(postReq({ response: { id: "cred1" } }));
    expect(h.passkeyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ deviceLabel: "iPhone · Safari" }),
    });
  });

  it("idempotent : credential déjà enrôlé → succès quand même", async () => {
    h.createThrows = true;
    expect((await POST(postReq(goodBody))).status).toBe(200);
  });
});
