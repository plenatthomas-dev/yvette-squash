import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/settings", () => ({
  getAnnouncement: async (id: string) =>
    id === "ann-1" ? { id, title: "Terrain fermé", body: "samedi", at: "2026-10-17T10:00:00Z" } : null,
}));

import { GET } from "./route";

const req = (id: string) => ({ nextUrl: new URL(`https://x/api/announce?id=${id}`) }) as unknown as NextRequest;

describe("GET /api/announce — seules les annonces réellement envoyées s'affichent", () => {
  it("rend le texte d'une annonce connue", async () => {
    const res = await GET(req("ann-1"));
    expect(await res.json()).toEqual({ title: "Terrain fermé", body: "samedi", at: "2026-10-17T10:00:00Z" });
  });

  it("404 pour un identifiant fabriqué", async () => {
    expect((await GET(req("faux"))).status).toBe(404);
  });
});
