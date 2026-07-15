import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  pushConfigured: true,
  pushToAll: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/push", () => ({
  pushToAll: h.pushToAll,
  pushConfigured: () => h.pushConfigured,
}));

import { POST } from "./route";

const postReq = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
  }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.pushConfigured = true;
  h.pushToAll.mockReset().mockResolvedValue({ recipients: 3, sent: 5 });
});

describe("POST /api/admin/announce", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    const res = await POST(postReq({ title: "T", body: "B" }));
    expect(res.status).toBe(403);
    expect(h.pushToAll).not.toHaveBeenCalled();
  });

  it("503 si VAPID non configuré", async () => {
    h.pushConfigured = false;
    const res = await POST(postReq({ title: "T", body: "B" }));
    expect(res.status).toBe(503);
    expect(h.pushToAll).not.toHaveBeenCalled();
  });

  it("400 si titre ou message vide (y compris espaces seuls / non-string)", async () => {
    expect((await POST(postReq({ title: "", body: "B" }))).status).toBe(400);
    expect((await POST(postReq({ title: "T", body: "" }))).status).toBe(400);
    expect((await POST(postReq({ title: "   ", body: "B" }))).status).toBe(400);
    expect((await POST(postReq({ body: "B" }))).status).toBe(400);
    expect((await POST(postReq({ title: 42, body: "B" }))).status).toBe(400);
    expect((await POST(postReq({}))).status).toBe(400);
    expect(h.pushToAll).not.toHaveBeenCalled();
  });

  it("400 si titre ou message trop long", async () => {
    expect((await POST(postReq({ title: "x".repeat(81), body: "B" }))).status).toBe(400);
    expect((await POST(postReq({ title: "T", body: "x".repeat(301) }))).status).toBe(400);
    expect(h.pushToAll).not.toHaveBeenCalled();
  });

  it("diffuse à tous, trim le titre/message et renvoie les compteurs", async () => {
    const res = await POST(postReq({ title: "  Terrain fermé  ", body: "  samedi  " }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, recipients: 3, sent: 5 });
    expect(h.pushToAll).toHaveBeenCalledTimes(1);
    // L'URL de clic porte l'annonce (titre + message) pour la ré-afficher en modale.
    const expectedUrl = `/?${new URLSearchParams({ announce: "1", t: "Terrain fermé", b: "samedi" }).toString()}`;
    expect(h.pushToAll).toHaveBeenCalledWith({
      title: "Terrain fermé",
      body: "samedi",
      url: expectedUrl,
      tag: "admin-announce",
    });
  });
});
