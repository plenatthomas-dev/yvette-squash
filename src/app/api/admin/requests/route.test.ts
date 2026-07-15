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
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_EMAIL_LOGIN() {
    return h.featureOn;
  },
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/moderation", () => ({ addBlock: h.addBlock }));
vi.mock("@/lib/email-auth", () => ({
  listPendingRequests: vi.fn(async () => h.pending),
  approveRequest: h.approveRequest,
  rejectRequest: h.rejectRequest,
  authLinkFor: (_o: string, _p: string, token: string) => `https://x/reinitialiser?token=${token}`,
}));

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

  it("approve : renvoie le lien", async () => {
    const res = await POST(postReq({ id: "r1", action: "approve" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.link).toContain("token=tok");
    expect(h.approveRequest).toHaveBeenCalledWith("r1", "adm");
  });

  it("approve : 404 si demande introuvable", async () => {
    h.approveResult = null;
    expect((await POST(postReq({ id: "r1", action: "approve" }))).status).toBe(404);
    h.approveResult = { token: "tok", purpose: "signup", email: "a@b.fr" };
  });

  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ id: "r1", action: "frobnicate" }))).status).toBe(400);
  });
});
