import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  /** Drapeau de fonction : la route admin le consulte AVANT les droits. */
  tricountOn: true,
  admin: { userId: "adm", email: "a@ex.com" } as null | { userId: string; email: string },
  list: [{ id: "t1" }] as unknown[],
  deleteTricount: vi.fn(),
}));

vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/tricount-admin", () => ({
  listTricountsAdmin: vi.fn(async () => h.list),
  deleteTricount: h.deleteTricount,
}));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const postReq = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.tricountOn = true;
  h.admin = { userId: "adm", email: "a@ex.com" };
  h.deleteTricount.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/admin/tricounts", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await GET(req())).status).toBe(403);
  });
  it("renvoie la liste", async () => {
    expect((await (await GET(req())).json()).tricounts).toHaveLength(1);
  });
});

describe("POST /api/admin/tricounts", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await POST(postReq({ id: "t1", action: "delete" }))).status).toBe(403);
  });
  it("400 si id manquant", async () => {
    expect((await POST(postReq({ action: "delete" }))).status).toBe(400);
    expect(h.deleteTricount).not.toHaveBeenCalled();
  });
  it("delete : supprime le tricount", async () => {
    const res = await POST(postReq({ id: "t1", action: "delete" }));
    expect(res.status).toBe(200);
    expect(h.deleteTricount).toHaveBeenCalledWith("t1");
  });
  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ id: "t1", action: "nope" }))).status).toBe(400);
  });
});

describe("/api/admin/tricounts — le drapeau avant les droits", () => {
  it("répond 404 quand la fonction est coupée, même à un admin", async () => {
    // Liste de contrôle : le drapeau D'ABORD. Cette route portait bien `requireAdmin` mais pas
    // la garde de fonction — elle restait la seule porte ouverte sur le tricount quand la
    // fonction est éteinte, et un 403 aurait de toute façon révélé qu'il y a quelque chose là.
    h.tricountOn = false;
    expect((await GET(req())).status).toBe(404);
    expect((await POST(postReq({ id: "t1", action: "delete" }))).status).toBe(404);
    expect(h.deleteTricount).not.toHaveBeenCalled();
  });
});
