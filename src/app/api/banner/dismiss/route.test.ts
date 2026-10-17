import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: { userId: "u1" } as null | { userId: string },
  setBannerSeen: vi.fn(async () => {}),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/settings", () => ({ setBannerSeen: h.setBannerSeen }));

import { POST } from "./route";

const req = (body: unknown) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => body,
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u1" };
});

describe("POST /api/banner/dismiss", () => {
  it("401 sans session", async () => {
    h.session = null;
    expect((await POST(req({ what: "banner", version: "v" }))).status).toBe(401);
  });

  it("mémorise une vraie version (horodatage ISO de l'annonce) sur le compte de la session", async () => {
    const version = "2026-10-17T12:00:00.000Z";
    const res = await POST(req({ what: "modal", version }));
    expect(res.status).toBe(200);
    expect(h.setBannerSeen).toHaveBeenCalledWith("u1", "modal", version);
  });

  it("accepte une version de 64 caractères — la borne est inclusive", async () => {
    expect((await POST(req({ what: "banner", version: "v".repeat(64) }))).status).toBe(200);
  });

  it("refuse en 400 une version de plus de 64 caractères, sans rien écrire", async () => {
    // Sans borne, un client bricolé écrivait n'importe quelle longueur dans la ligne User.
    const res = await POST(req({ what: "banner", version: "v".repeat(65) }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Version invalide." });
    expect(h.setBannerSeen).not.toHaveBeenCalled();
  });

  it("refuse une cible inconnue ou une version absente", async () => {
    expect((await POST(req({ what: "toast", version: "v" }))).status).toBe(400);
    expect((await POST(req({ what: "banner" }))).status).toBe(400);
    expect((await POST(req({ what: "banner", version: 42 }))).status).toBe(400);
    expect(h.setBannerSeen).not.toHaveBeenCalled();
  });
});
