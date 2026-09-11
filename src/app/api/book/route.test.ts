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
  getPlanning: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { booking: { findFirst: h.findFirst, upsert: h.upsert } },
}));
vi.mock("@/lib/resamania/client", () => ({
  book: h.book,
  getPlanning: h.getPlanning,
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

/** Le créneau TEL QUE LE PLANNING le donne — la seule source d'autorité de la route. */
const CRENEAU = {
  id: BODY.classEventId,
  courtName: "Squash 1",
  startsAt: "2026-07-11T18:00:00.000Z",
  endsAt: "2026-07-11T18:45:00.000Z",
};

beforeEach(() => {
  h.session = { userId: "me" };
  h.acting = CTX_DELEGATION;
  h.clash = null;
  h.bookResult = { ok: true, state: "validated", attendeeId: "att-1" };
  h.findFirst.mockReset().mockImplementation(async () => h.clash);
  h.upsert.mockReset().mockResolvedValue({});
  h.book.mockReset().mockImplementation(async () => h.bookResult);
  h.getPlanning.mockReset().mockResolvedValue({ slots: [CRENEAU] });
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

  it("repasse la source à « app » sur une ligne réutilisée", async () => {
    // Régression : la ligne peut avoir été marquée "resamania" par la réconciliation (résa
    // faite hors appli, annulée, puis refaite ici). L'upsert doit corriger l'origine, sinon
    // la résa reste comptée « hors appli » dans le journal et la stat admin.
    await POST(postReq(BODY));
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({ source: "app" });
    expect(arg.create).toMatchObject({ source: "app" });
  });

  it("409 overlap si ResaMania signale has-overlapping-slots", async () => {
    h.bookResult = { ok: false, error: "…listAttendees: has-overlapping-slots…" };
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("overlap");
  });
});

// `startsAt` ne dit plus l'horaire — il dit QUEL JOUR lire dans le planning — mais il reste
// exigé et contrôlé : une date absurde ferait interroger ResaMania pour rien. (`courtName` et
// `endsAt` ne sont plus validés : la route les ignore, cf. le commentaire de `POST`.)
it.each([
  { startsAt: undefined }, { startsAt: "invalid" }, { startsAt: 5 },
  { startsAt: "2026-02-31T18:00:00Z" }, { startsAt: "5" }, { startsAt: "2026-09-10" },
])("refuse un jour mal formé AVANT de lire le planning : %j", async (change) => {
  expect((await POST(postReq({ ...BODY, ...change }))).status).toBe(400);
  expect(h.getPlanning).not.toHaveBeenCalled();
  expect(h.book).not.toHaveBeenCalled();
  expect(h.upsert).not.toHaveBeenCalled();
});

describe("POST /api/book — le créneau vient du planning, jamais du navigateur", () => {
  it("⚠️ écrit au journal le terrain et l'horaire DU PLANNING, pas ceux du corps", async () => {
    // LE DÉFAUT. `courtName`, `startsAt` et `endsAt` étaient recopiés du corps de la requête,
    // contrôlés dans leur seule FORME. Un membre authentifié pouvait réserver un vrai créneau
    // et faire écrire « Terrain 99, 3 h du matin » dans le journal partagé du club.
    //
    // Et la réconciliation ne le rattrapait pas : elle cherche les résas d'un jour par
    // `startsAt` — une date falsifiée sort de la fenêtre et n'est jamais relue — et apparie
    // sur `classEventId` sans corriger ni le terrain ni l'horaire.
    const res = await POST(postReq({
      ...BODY,
      courtName: "Terrain 99",
      startsAt: "2026-07-11T03:00:00.000Z",
      endsAt: "2026-07-11T23:59:00.000Z",
    }));
    expect(res.status).toBe(200);

    for (const cote of ["create", "update"] as const) {
      expect(h.upsert.mock.calls[0][0][cote]).toMatchObject({
        courtName: "Squash 1",
        startsAt: new Date(CRENEAU.startsAt),
        endsAt: new Date(CRENEAU.endsAt),
      });
    }
  });

  it("cherche le créneau dans le planning DU JOUR annoncé", async () => {
    await POST(postReq(BODY));
    expect(h.getPlanning).toHaveBeenCalledWith("2026-07-11", "tok-delegant");
  });

  it("⚠️ « un terrain par horaire » se juge sur l'horaire du PLANNING", async () => {
    // Sur l'horaire annoncé par le navigateur, il suffisait d'en annoncer un autre pour
    // passer à côté de sa propre réservation concurrente.
    await POST(postReq({ ...BODY, startsAt: "2026-07-11T05:00:00.000Z" }));
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ startsAt: new Date(CRENEAU.startsAt) }),
      }),
    );
  });

  it("409 sans appeler ResaMania si le créneau n'est pas dans le planning de ce jour", async () => {
    // Deux causes, un seul refus : créneau disparu, ou jour qui n'est pas le sien. Dans les
    // deux cas on ignore ce qu'on réserverait — donc on ne demande pas à ResaMania de le dire.
    h.getPlanning.mockResolvedValue({ slots: [{ ...CRENEAU, id: "/class_events/autre" }] });
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(409);
    expect(h.book).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("502 sans rien réserver si le planning est illisible", async () => {
    // Un échec amont n'est pas la faute du membre, et surtout : on ne réserve pas à l'aveugle.
    h.getPlanning.mockRejectedValue(new Error("Planning indisponible (503)"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(postReq(BODY));
    expect(res.status).toBe(502);
    // Le détail amont reste côté serveur (même doctrine que /api/planning).
    expect((await res.json()).error).not.toContain("503");
    expect(h.book).not.toHaveBeenCalled();
  });
});
