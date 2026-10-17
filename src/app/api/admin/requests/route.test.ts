import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  featureOn: true,
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  pending: [{ id: "r1", email: "a@b.fr", purpose: "signup", displayName: null, createdAt: "d" }],
  approveResult: { token: "tok", purpose: "signup" as const, email: "a@b.fr" } as
    | { token: string; purpose: "signup" | "reset"; email: string }
    | null,
  rejectResult: "a@b.fr" as string | null,
  addBlock: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  mailOn: false,
  pendingPurpose: "signup" as "signup" | "reset" | null,
  sendReset: vi.fn(),
  sendSignup: vi.fn(),
  revert: vi.fn(),
}));

// Le flag est résolu à chaud côté serveur (env + override en base) : on mocke l'état effectif.
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: h.featureOn,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/moderation", () => ({ addBlock: h.addBlock }));
vi.mock("@/lib/email-auth", () => ({
  listPendingRequests: vi.fn(async () => h.pending),
  approveRequest: h.approveRequest,
  rejectRequest: h.rejectRequest,
  authLinkFor: (_o: string, _p: string, token: string) => `https://x/reinitialiser?token=${token}`,
  pendingRequestPurpose: vi.fn(async () => h.pendingPurpose),
  revertApproval: h.revert,
  sendResetEmail: h.sendReset,
  sendSignupApprovedEmail: h.sendSignup,
}));
vi.mock("@/lib/email", () => ({ emailConfigured: () => h.mailOn }));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const postReq = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
    nextUrl: { origin: "https://x" },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.featureOn = true;
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.addBlock.mockReset().mockResolvedValue("a@b.fr");
  h.approveRequest.mockReset().mockImplementation(async () => h.approveResult);
  h.rejectRequest.mockReset().mockImplementation(async () => h.rejectResult);
  h.mailOn = false;
  h.pendingPurpose = "signup";
  h.approveResult = { token: "tok", purpose: "signup", email: "a@b.fr" };
  h.sendReset.mockReset().mockResolvedValue(undefined);
  h.sendSignup.mockReset().mockResolvedValue(undefined);
  h.revert.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/admin/requests", () => {
  it("404 si fonction désactivée", async () => {
    h.featureOn = false;
    expect((await GET(req())).status).toBe(404);
  });
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await GET(req())).status).toBe(403);
  });
  it("renvoie la file", async () => {
    expect((await (await GET(req())).json()).requests).toHaveLength(1);
  });
});

describe("POST /api/admin/requests", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await POST(postReq({ id: "r1", action: "reject" }))).status).toBe(403);
  });

  it("400 si id manquant", async () => {
    expect((await POST(postReq({ action: "reject" }))).status).toBe(400);
  });

  it("reject : journalise avec l'id admin, sans bloquer", async () => {
    const res = await POST(postReq({ id: "r1", action: "reject" }));
    expect(res.status).toBe(200);
    expect(h.rejectRequest).toHaveBeenCalledWith("r1", "adm");
    expect(h.addBlock).not.toHaveBeenCalled();
  });

  it("reject-block : rejette ET bloque l'e-mail renvoyé", async () => {
    const res = await POST(postReq({ id: "r1", action: "reject-block" }));
    expect(res.status).toBe(200);
    expect(h.rejectRequest).toHaveBeenCalledWith("r1", "adm");
    expect(h.addBlock).toHaveBeenCalledWith("a@b.fr", expect.any(String), "adm");
  });

  it("reject-block : ne bloque pas si la demande n'existait plus", async () => {
    h.rejectResult = null;
    await POST(postReq({ id: "r1", action: "reject-block" }));
    expect(h.addBlock).not.toHaveBeenCalled();
    h.rejectResult = "a@b.fr";
  });

  it("approve d'une réinitialisation SANS e-mail : 409, rien n'est approuvé", async () => {
    h.pendingPurpose = "reset";
    const res = await POST(postReq({ id: "r1", action: "approve" }));
    expect(res.status).toBe(409);
    expect(h.approveRequest).not.toHaveBeenCalled();
  });

  it("approve AVEC e-mail : le lien part à l'adresse, jamais à l'admin", async () => {
    h.mailOn = true;
    h.approveResult = { token: "tok", purpose: "reset", email: "a@b.fr" };
    const res = await POST(postReq({ id: "r1", action: "approve" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sent: true, email: "a@b.fr" });
    expect(body.link).toBeUndefined();
    expect(h.sendReset).toHaveBeenCalledWith("a@b.fr", "https://x", "tok");
  });

  it("approve d'une inscription AVEC e-mail : lien d'activation envoyé", async () => {
    h.mailOn = true;
    const body = await (await POST(postReq({ id: "r1", action: "approve" }))).json();
    expect(body.sent).toBe(true);
    expect(h.sendSignup).toHaveBeenCalledWith("a@b.fr", "https://x/reinitialiser?token=tok");
  });

  it("envoi raté : 502 et la demande revient dans la file", async () => {
    h.mailOn = true;
    h.sendSignup.mockRejectedValue(new Error("smtp"));
    const res = await POST(postReq({ id: "r1", action: "approve" }));
    expect(res.status).toBe(502);
    expect(h.revert).toHaveBeenCalledWith("r1");
  });

  it("approve d'une inscription sans e-mail configuré : renvoie le lien", async () => {
    const res = await POST(postReq({ id: "r1", action: "approve" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.link).toContain("token=tok");
    expect(h.approveRequest).toHaveBeenCalledWith("r1", "adm");
  });

  it("approve : 404 si demande introuvable", async () => {
    h.approveResult = null;
    expect((await POST(postReq({ id: "r1", action: "approve" }))).status).toBe(404);
  });

  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ id: "r1", action: "frobnicate" }))).status).toBe(400);
  });
});
