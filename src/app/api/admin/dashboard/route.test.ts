import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "a@ex.com" } as null | { userId: string; email: string },
  data: { members: 12, crons: [] as unknown[] },
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/dashboard", () => ({ getDashboard: vi.fn(async () => h.data) }));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "a@ex.com" };
});

describe("GET /api/admin/dashboard", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await GET(req())).status).toBe(403);
  });
  it("renvoie les indicateurs", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).members).toBe(12);
  });
});
