import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ResaOutcomeUnknownError, ResaUnavailableError } from "@/lib/resamania/errors";

// PANNES RESAMANIA SUR L'ANNULATION DEPUIS « MES RÉSERVATIONS ». Même règle que
// /api/cancel-slot (cf. lib/resamania/responses.ts) : lecture ratée → 503 « réessaie » ;
// écriture partie sans réponse → 504 « vérifie le planning », journal laissé « booked ».

const h = vi.hoisted(() => ({
  session: { userId: "me" } as null | { userId: string },
  acting: null as null | Record<string, unknown>,
  booking: null as null | Record<string, unknown>,
  findAttendeeId: vi.fn(),
  cancel: vi.fn(),
  invalidatePlanningCache: vi.fn(),
  bookingUpdate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/app-block", () => ({
  appBlockForUserId: vi.fn(async () => null),
  appBlockedResponse: vi.fn(),
}));
vi.mock("@/lib/delegation", () => ({ resolveActingContext: vi.fn(async () => h.acting) }));
vi.mock("@/lib/resamania/client", () => ({
  findAttendeeId: h.findAttendeeId,
  cancel: h.cancel,
  invalidatePlanningCache: h.invalidatePlanningCache,
}));
vi.mock("@/lib/db", () => ({
  prisma: { booking: { findUnique: vi.fn(async () => h.booking), update: h.bookingUpdate } },
}));
vi.mock("@/lib/planning-snapshot", () => ({ refreshSnapshotFromResa: vi.fn() }));

import { DELETE } from "./route";

const delReq = () =>
  ({ cookies: { get: () => undefined }, json: async () => ({}) }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "b1" }) };

beforeEach(() => {
  h.session = { userId: "me" };
  h.acting = { ok: true, ctx: { resa: { accessToken: "tok" }, bookingOwnerId: "me", actingUserId: null } };
  h.booking = {
    id: "b1",
    userId: "me",
    attendeeId: "/t/attendees/9",
    classEventId: "/t/class_events/1",
    startsAt: new Date("2026-10-20T18:00:00Z"),
  };
  h.findAttendeeId.mockReset().mockResolvedValue("/t/attendees/9");
  h.cancel.mockReset().mockResolvedValue({ ok: true, state: "canceled" });
  h.invalidatePlanningCache.mockReset();
  h.bookingUpdate.mockReset().mockResolvedValue({});
});

describe("DELETE /api/bookings/[id] — pannes ResaMania", () => {
  it("cas nominal : annule et passe le journal « cancelled »", async () => {
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(200);
    expect(h.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { status: "cancelled", actingUserId: null },
    });
  });

  it("attendeeId à retrouver, ResaMania injoignable → 503 « réessaie », pas 422 « introuvable »", async () => {
    h.booking = { ...h.booking, attendeeId: null };
    h.findAttendeeId.mockImplementation(() =>
      Promise.reject(new ResaUnavailableError("ResaMania injoignable (TimeoutError)")),
    );
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "ResaMania ne répond pas, réessaie dans un instant.",
      code: "resa-unavailable",
    });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("annulation partie sans réponse → 504 outcome-unknown, cache vidé, journal intact", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.cancel.mockImplementation(() =>
      Promise.reject(new ResaOutcomeUnknownError("ResaMania n'a pas répondu à temps")),
    );
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body).toEqual({
      error: "L'annulation n'a pas pu être confirmée : vérifie le planning.",
      code: "outcome-unknown",
    });
    expect(body.error).not.toMatch(/réessaie/i);
    expect(h.invalidatePlanningCache).toHaveBeenCalled();
    expect(h.bookingUpdate).not.toHaveBeenCalled();
  });
});
