import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// GET /api/week — deux défauts d'entrée et une sur-lecture :
//  - « ?date=abc » faisait lever `weekDates` (RangeError) hors du `try` → 500 au lieu de 400 ;
//  - sans date, la semaine par défaut se calculait sur la date UTC, soit la VEILLE entre minuit
//    et 2 h à Paris — la semaine précédente un lundi après minuit ;
//  - les présences ramenaient la ligne User entière (hash de mot de passe compris) pour n'en
//    lire que le nom.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; resa?: unknown },
  snapFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  attendanceFindMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    planningSnapshot: { findMany: h.snapFindMany },
    booking: { findMany: h.bookingFindMany },
    attendance: { findMany: h.attendanceFindMany },
  },
}));
vi.mock("@/lib/resamania/client", () => ({ getPlanning: vi.fn(), getStudios: vi.fn() }));
vi.mock("@/lib/planning-annotate", () => ({ loadAnnotationUsers: vi.fn(async () => []) }));

import { GET } from "./route";

const get = (qs = "") =>
  ({
    cookies: { get: () => undefined },
    url: `https://club.example/api/week${qs}`,
  }) as unknown as NextRequest;

/** Un créneau réservé : sans lui, l'annotation ne lit ni réservations ni présences. */
const SNAP = (date: string) => ({
  date,
  updatedAt: new Date(),
  payloadJson: JSON.stringify({
    date,
    clubId: "c",
    courts: [],
    slots: [{ id: `/ev/${date}`, bookable: false, startsAt: `${date}T18:00:00Z` }],
  }),
});

beforeEach(() => {
  // Compte « email seul » : chemin sans ResaMania, entièrement servi par la base bouchonnée.
  h.session = { userId: "u1" };
  h.snapFindMany.mockReset().mockImplementation(async ({ where }) => where.date.in.map(SNAP));
  h.bookingFindMany.mockReset().mockResolvedValue([]);
  h.attendanceFindMany.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/week — date demandée", () => {
  it.each(["abc", "2026-02-31", "2026-13-01", "20261017"])("400 sur « ?date=%s »", async (d) => {
    const res = await GET(get(`?date=${d}`));
    expect(res.status).toBe(400);
    expect(h.snapFindMany).not.toHaveBeenCalled();
  });

  it("rend les 7 jours (lundi → dimanche) d'une date réelle", async () => {
    const res = await GET(get("?date=2026-10-15"));
    expect(res.status).toBe(200);
    const days = (await res.json()) as { date: string }[];
    expect(days.map((d) => d.date)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
      "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
  });

  it("sans date : la semaine d'AUJOURD'HUI À L'HEURE DU CLUB, pas de la veille UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Lundi 19 octobre 2026, 0 h 30 à Paris = dimanche 18, 22 h 30 UTC.
    vi.setSystemTime(new Date("2026-10-18T22:30:00Z"));
    const days = (await (await GET(get())).json()) as { date: string }[];
    expect(days[0].date).toBe("2026-10-19"); // et non le lundi 12 de la semaine UTC
  });
});

describe("GET /api/week — lecture des membres", () => {
  it("ne lit que le nom du membre pour chaque présence", async () => {
    await GET(get("?date=2026-10-15"));
    expect(h.attendanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { user: { select: { displayName: true } } } }),
    );
  });
});
