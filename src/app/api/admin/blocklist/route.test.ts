import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  listBlocks: vi.fn(),
  addBlock: vi.fn(),
  removeBlock: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/moderation", () => ({
  listBlocks: h.listBlocks,
  addBlock: h.addBlock,
  removeBlock: h.removeBlock,
}));
// EMAIL_RE réel (email-auth n'importe rien de lourd pour cette constante).
vi.mock("@/lib/email-auth", () => ({ EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const postReq = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.listBlocks.mockReset().mockResolvedValue([{ email: "spam@x.fr", reason: null, createdAt: "d" }]);
  h.addBlock.mockReset().mockResolvedValue("spam@x.fr");
  h.removeBlock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/admin/blocklist", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await GET(req())).status).toBe(403);
  });
  it("renvoie la liste", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).blocks).toHaveLength(1);
  });
});

describe("POST /api/admin/blocklist", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await POST(postReq({ action: "add", email: "a@b.fr" }))).status).toBe(403);
  });
  it("400 si e-mail invalide", async () => {
    expect((await POST(postReq({ action: "add", email: "pasunemail" }))).status).toBe(400);
    expect(h.addBlock).not.toHaveBeenCalled();
  });
  it("add : bloque avec motif + admin", async () => {
    const res = await POST(postReq({ action: "add", email: "spam@x.fr", reason: "  abus  " }));
    expect(res.status).toBe(200);
    expect(h.addBlock).toHaveBeenCalledWith("spam@x.fr", "abus", "adm");
  });
  it("add : motif vide → null", async () => {
    await POST(postReq({ action: "add", email: "spam@x.fr", reason: "   " }));
    expect(h.addBlock).toHaveBeenCalledWith("spam@x.fr", null, "adm");
  });
  it("remove : débloque", async () => {
    const res = await POST(postReq({ action: "remove", email: "spam@x.fr" }));
    expect(res.status).toBe(200);
    expect(h.removeBlock).toHaveBeenCalledWith("spam@x.fr");
  });
  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ action: "nope", email: "a@b.fr" }))).status).toBe(400);
  });
});
