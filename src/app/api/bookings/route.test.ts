import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// GET /api/bookings — « ?date=abc » donnait `new Date("abcT00:00:00")`, date invalide que
// Prisma refuse en levant → 500. Et chaque résa ramenait la ligne User ENTIÈRE (hash de mot de
// passe compris) alors que la réponse n'en expose que `displayName`.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  findMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({ prisma: { booking: { findMany: h.findMany } } }));
vi.mock("@/lib/features-server", () => ({ getFeatures: vi.fn(async () => ({ delegation: false })) }));
vi.mock("@/lib/delegation", () => ({ getActiveIncomingDelegations: vi.fn(async () => []) }));

import { GET } from "./route";

const get = (qs = "") =>
  ({
    cookies: { get: () => undefined },
    url: `https://club.example/api/bookings${qs}`,
  }) as unknown as NextRequest;

beforeEach(() => {
  h.session = { userId: "u1" };
  h.findMany.mockReset().mockResolvedValue([
    {
      id: "b1",
      userId: "u1",
      courtName: "Squash 1",
      startsAt: new Date("2026-10-15T16:00:00Z"),
      endsAt: new Date("2026-10-15T16:45:00Z"),
      source: "app",
      user: { displayName: "Thomas P." },
    },
  ]);
});

describe("GET /api/bookings", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(get())).status).toBe(401);
  });

  it.each(["abc", "2026-02-31", "2026-10-32", "15/10/2026"])("400 sur « ?date=%s »", async (d) => {
    const res = await GET(get(`?date=${d}`));
    expect(res.status).toBe(400);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("une date réelle filtre la journée", async () => {
    const res = await GET(get("?date=2026-10-15"));
    expect(res.status).toBe(200);
    expect(h.findMany.mock.calls[0][0].where.startsAt.gte).toBeInstanceOf(Date);
  });

  it("« ?date= » vide reste « à venir », comme avant", async () => {
    expect((await GET(get("?date="))).status).toBe(200);
  });

  it("ne lit que le nom du membre, et l'expose", async () => {
    const body = await (await GET(get())).json();
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { user: { select: { displayName: true } } } }),
    );
    expect(body[0]).toMatchObject({ displayName: "Thomas P.", mine: true });
  });
});
