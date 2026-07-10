import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// La route book CONSOMME le contexte d'action résolu par resolveActingContext (testé
// isolément dans lib/delegation.test.ts). Ici on vérifie qu'elle l'honore : refus relayé
// tel quel, règle « un terrain par horaire » évaluée sur le PROPRIÉTAIRE (le délégant en
// cas de délégation), réservation avec le jeton du contexte, traçabilité actingUserId.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  acting: null as null | Record<string, unknown>,
  clash: null as null | Record<string, unknown>,
  bookResult: { ok: true, state: "validated", attendeeId: "att-1" } as Record<string, unknown>,
  findFirst: vi.fn(),
  upsert: vi.fn(),
  book: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { booking: { findFirst: h.findFirst, upsert: h.upsert } },
}));
vi.mock("@/lib/resamania/client", () => ({
  book: h.book,
  invalidatePlanningCache: vi.fn(),
}));
vi.mock("@/lib/validation", () => ({
  isClassEventId: (v: unknown) => typeof v === "string" && v.length > 0,
}));
vi.mock("@/lib/delegation", () => ({
  resolveActingContext: vi.fn(async () => h.acting),
}));

import { POST } from "./route";

const RESA_DELEGANT = { accessToken: "tok-delegant" };
const CTX_DELEGATION = {
  ok: true,
  ctx: { resa: RESA_DELEGANT, bookingOwnerId: "delegator", actingUserId: "me" },
};

const postReq = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
  }) as unknown as NextRequest;

const BODY = {
  classEventId: "/class_events/123",
  courtName: "Squash 1",
  startsAt: "2026-07-11T18:00:00.000Z",
  endsAt: "2026-07-11T18:45:00.000Z",
  onBehalfOf: "delegator",
};

beforeEach(() => {
  h.session = { userId: "me" };
  h.acting = CTX_DELEGATION;
  h.clash = null;
  h.bookResult = { ok: true, state: "validated", attendeeId: "att-1" };
  h.findFirst.mockReset().mockImplementation(async () => h.clash);
  h.upsert.mockReset().mockResolvedValue({});
  h.book.mockReset().mockImplementation(async () => h.bookResult);
});

describe("POST /api/book (délégation)", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(postReq(BODY))).status).toBe(401);
  });

  it("relaie tel quel le refus du contexte d'action (statut + message)", async () => {
    h.acting = { ok: false, status: 403, error: "Délégation introuvable, expirée ou révoquée." };
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Délégation");
    expect(h.book).not.toHaveBeenCalled();
  });

  it("règle « un terrain par horaire » évaluée sur le DÉLÉGANT (propriétaire)", async () => {
    h.clash = { courtName: "Squash 2" };
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("overlap");
    // Le court-circuit local doit viser le compte qui réserve réellement : le délégant.
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "delegator" }) }),
    );
    expect(h.book).not.toHaveBeenCalled();
  });

  it("réserve avec le JETON du contexte et trace qui a agi", async () => {
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(200);
    // Jeton du délégant, jamais le mien.
    expect(h.book).toHaveBeenCalledWith(RESA_DELEGANT, BODY.classEventId);
    // Journal : la résa appartient au délégant, actingUserId trace le délégué.
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.where.userId_classEventId.userId).toBe("delegator");
    expect(arg.create).toMatchObject({ userId: "delegator", actingUserId: "me" });
    expect(arg.update).toMatchObject({ actingUserId: "me" });
  });

  it("409 overlap si ResaMania signale has-overlapping-slots", async () => {
    h.bookResult = { ok: false, error: "…listAttendees: has-overlapping-slots…" };
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("overlap");
  });
});
