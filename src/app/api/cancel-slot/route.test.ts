import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ResaOutcomeUnknownError, ResaUnavailableError } from "@/lib/resamania/errors";

// PANNES RESAMANIA SUR L'ANNULATION DEPUIS LA GRILLE. Deux erreurs, deux consignes opposées
// (cf. lib/resamania/responses.ts) :
//  - la recherche de l'attendee (lecture) n'aboutit pas → 503 « réessaie » : rien n'a bougé.
//    Avant, `findAttendeeId` rendait null et la route répondait « Réservation introuvable côté
//    ResaMania » (404) : le membre croyait sa résa disparue ;
//  - l'annulation (écriture) part sans réponse → 504 « vérifie le planning » : elle a peut-être
//    abouti, « réessaie » serait trompeur, « annulée » peut-être faux.

const h = vi.hoisted(() => ({
  session: { userId: "me" } as null | { userId: string },
  acting: null as null | Record<string, unknown>,
  findAttendeeId: vi.fn(),
  cancel: vi.fn(),
  invalidatePlanningCache: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingUpdateMany: vi.fn(),
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
  prisma: { booking: { findFirst: h.bookingFindFirst, updateMany: h.bookingUpdateMany } },
}));
vi.mock("@/lib/validation", () => ({
  isClassEventId: (v: unknown) => typeof v === "string" && v.length > 0,
}));
vi.mock("@/lib/planning-snapshot", () => ({ refreshSnapshotFromResa: vi.fn() }));

import { POST } from "./route";

const postReq = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const BODY = { classEventId: "/t/class_events/1" };

beforeEach(() => {
  h.session = { userId: "me" };
  h.acting = { ok: true, ctx: { resa: { accessToken: "tok" }, bookingOwnerId: "me", actingUserId: null } };
  h.findAttendeeId.mockReset().mockResolvedValue("/t/attendees/9");
  h.cancel.mockReset().mockResolvedValue({ ok: true, state: "canceled" });
  h.invalidatePlanningCache.mockReset();
  h.bookingFindFirst.mockReset().mockResolvedValue(null);
  h.bookingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("POST /api/cancel-slot — pannes ResaMania", () => {
  it("cas nominal : annule et aligne le journal", async () => {
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(200);
    expect(h.bookingUpdateMany).toHaveBeenCalled();
  });

  it("attendee introuvable pour de vrai → 404, comme avant", async () => {
    h.findAttendeeId.mockResolvedValue(null);
    expect((await POST(postReq(BODY))).status).toBe(404);
  });

  it("ResaMania injoignable à la recherche de l'attendee → 503 « réessaie », pas « introuvable »", async () => {
    h.findAttendeeId.mockImplementation(() =>
      Promise.reject(new ResaUnavailableError("Attendees : ResaMania indisponible (503)", 503)),
    );
    const res = await POST(postReq(BODY));
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
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body).toEqual({
      error: "L'annulation n'a pas pu être confirmée : vérifie le planning.",
      code: "outcome-unknown",
    });
    expect(body.error).not.toMatch(/réessaie/i);
    expect(h.invalidatePlanningCache).toHaveBeenCalled();
    // Le journal n'est pas passé « cancelled » sur une annulation peut-être ratée : la
    // réconciliation du planning tranchera.
    expect(h.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("relaie le 503 et son `code` quand le contexte d'action signale la panne", async () => {
    h.acting = {
      ok: false,
      status: 503,
      error: "ResaMania ne répond pas, réessaie dans un instant.",
      code: "resa-unavailable",
    };
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("resa-unavailable");
    expect(h.findAttendeeId).not.toHaveBeenCalled();
  });
});
