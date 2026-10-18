import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  authorized: true,
  runs: [] as { name: string; lastRunAt: Date; ok: boolean; info: string | null }[],
}));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/db", () => ({ prisma: { cronRun: { findMany: async () => h.runs } } }));

import { GET } from "./route";
import { CRON_CADENCES } from "@/lib/cron-run";

const req = () => ({}) as NextRequest;
const frais = () =>
  Object.keys(CRON_CADENCES).map((name) => ({ name, lastRunAt: new Date(), ok: true, info: null }));

beforeEach(() => {
  h.authorized = true;
  h.runs = frais();
});

describe("GET /api/cron/health-summary", () => {
  it("401 sans secret", async () => {
    h.authorized = false;
    expect((await GET(req())).status).toBe(401);
  });

  it("200 quand tout est à l'heure et vert", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, problems: [] });
  });

  it("503 sur un cron en retard", async () => {
    h.runs[0] = { ...h.runs[0], lastRunAt: new Date(Date.now() - 60 * 86_400_000) };
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).problems[0]).toMatchObject({ name: h.runs[0].name, late: true });
  });

  it("503 sur un cron surveillé au rouge ; un geste d'admin au rouge ne compte pas", async () => {
    h.runs.push({ name: "warm-rankings-manuel", lastRunAt: new Date(), ok: false, info: null });
    expect((await GET(req())).status).toBe(200);
    h.runs[1] = { ...h.runs[1], ok: false };
    expect((await GET(req())).status).toBe(503);
  });

  it("503 quand un cron attendu n'a jamais tourné", async () => {
    h.runs = h.runs.slice(1);
    expect((await GET(req())).status).toBe(503);
  });
});
