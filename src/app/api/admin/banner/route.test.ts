import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  setBanner: vi.fn(),
  clearBanner: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/settings", () => ({
  BANNER_MAX: 280,
  setBanner: h.setBanner,
  clearBanner: h.clearBanner,
}));

import { POST } from "./route";

const postReq = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.setBanner.mockReset().mockResolvedValue(undefined);
  h.clearBanner.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/admin/banner", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await POST(postReq({ message: "coucou" }))).status).toBe(403);
    expect(h.setBanner).not.toHaveBeenCalled();
  });

  it("400 si message trop long", async () => {
    const res = await POST(postReq({ message: "x".repeat(281) }));
    expect(res.status).toBe(400);
    expect(h.setBanner).not.toHaveBeenCalled();
  });

  it("message vide → retire la bannière", async () => {
    const res = await POST(postReq({ message: "   " }));
    expect(res.status).toBe(200);
    expect((await res.json()).banner).toBeNull();
    expect(h.clearBanner).toHaveBeenCalledTimes(1);
    expect(h.setBanner).not.toHaveBeenCalled();
  });

  it("message absent → retire la bannière", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(200);
    expect(h.clearBanner).toHaveBeenCalledTimes(1);
  });

  it("pose la bannière (level info par défaut, trim, updatedById = admin)", async () => {
    const res = await POST(postReq({ message: "  Assemblée vendredi  " }));
    expect(res.status).toBe(200);
    expect(h.setBanner).toHaveBeenCalledWith("Assemblée vendredi", "info", "adm");
  });

  it("level warn respecté", async () => {
    await POST(postReq({ message: "Terrain fermé", level: "warn" }));
    expect(h.setBanner).toHaveBeenCalledWith("Terrain fermé", "warn", "adm");
  });

  it("level inconnu → info", async () => {
    await POST(postReq({ message: "Hop", level: "rouge-vif" }));
    expect(h.setBanner).toHaveBeenCalledWith("Hop", "info", "adm");
  });
});
