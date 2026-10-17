import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// /api/planning : la réconciliation (écritures DESTRUCTIVES dans le journal des résas) ne doit
// tourner que sur une photo lue à l'instant, jamais sur le cache mémoire ; et la date demandée
// doit être un vrai jour, par défaut celui du CLUB et non celui d'UTC.

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  getPlanningWithMeta: vi.fn(),
  reconcile: vi.fn(async (..._args: unknown[]) => {}),
  snapFind: vi.fn(async (_args: unknown) => null),
  snapUpsert: vi.fn(async (_args: unknown) => ({})),
}));

vi.mock("@/lib/session", () => ({ getSession: h.getSession }));
vi.mock("@/lib/resamania/client", () => ({ getPlanningWithMeta: h.getPlanningWithMeta }));
vi.mock("@/lib/booking-reconcile", () => ({ reconcilePlanningWithBookings: h.reconcile }));
vi.mock("@/lib/planning-annotate", () => ({ annotatePlanning: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({
  prisma: { planningSnapshot: { findUnique: h.snapFind, upsert: h.snapUpsert } },
}));

import { GET } from "./route";

const req = (qs: string) =>
  ({
    url: `https://app.test/api/planning${qs}`,
    cookies: { get: () => ({ value: "sid" }) },
  }) as unknown as NextRequest;

const planning = (date: string) => ({ date, clubId: "c", courts: [], slots: [] });

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue({ userId: "u1", resa: { accessToken: "tok" } });
  h.getPlanningWithMeta.mockImplementation(async (date: string) => ({
    planning: planning(date),
    fetchedAt: 1_000,
    fromCache: false,
  }));
});
afterEach(() => vi.useRealTimers());

describe("GET /api/planning — réconciliation", () => {
  it("photo lue à l'instant → réconcilie, avec l'instant de la photo", async () => {
    const res = await GET(req("?date=2026-10-17"));
    expect(res.status).toBe(200);
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-10-17" }), "2026-10-17", 1_000);
  });

  it("planning servi par le CACHE → aucune réconciliation", async () => {
    // Le cache peut précéder une résa faite entre-temps sur une autre instance : la
    // réconciliation l'aurait passée en « cancelled ».
    h.getPlanningWithMeta.mockResolvedValue({ planning: planning("2026-10-17"), fetchedAt: 1_000, fromCache: true });
    const res = await GET(req("?date=2026-10-17"));
    expect(res.status).toBe(200);
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});

describe("GET /api/planning — date", () => {
  it("refuse une date impossible ou mal formée (400) sans appeler ResaMania", async () => {
    for (const d of ["2026-02-31", "demain", "2026-1-5"]) {
      const res = await GET(req(`?date=${d}`));
      expect(res.status).toBe(400);
    }
    expect(h.getPlanningWithMeta).not.toHaveBeenCalled();
  });

  it("par défaut : la date du jour À L'HEURE DU CLUB, pas celle d'UTC", async () => {
    // 22:30 UTC le 17 octobre = 00:30 le 18 à Paris (heure d'été) : l'ancien
    // `toISOString().slice(0, 10)` aurait servi le planning de la veille.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T22:30:00Z"));
    await GET(req(""));
    expect(h.getPlanningWithMeta.mock.calls[0][0]).toBe("2026-10-18");
  });
});
