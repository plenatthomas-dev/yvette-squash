import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un invité hors asso ne peut pas se connecter pour déclarer lui-même son
// remboursement (route classique { toId }) : c'est le créancier connecté qui
// confirme avoir reçu, via { fromGuestId }. Ce fichier couvre CETTE branche —
// la branche { toId } (auto-déclaration classique) est inchangée.

const h = vi.hoisted(() => ({
  session: { userId: "creditor", displayName: "Créancier", resa: {} as unknown } as {
    userId: string;
  } | null,
  guest: null as null | { tricountId: string },
  tricount: null as null | Record<string, unknown>,
  create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "refund1",
    ...args.data,
  })),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: true,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    tricountGuest: { findUnique: vi.fn(async () => h.guest) },
    $transaction: async (
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      fn({
        tricount: { findUnique: vi.fn(async () => h.tricount) },
        expense: { create: h.create },
      }),
  },
}));

import { POST } from "./route";

const req = (body: unknown) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => body,
  }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "t1" }) };

// Un invité (guest1) doit 1000 au créancier connecté (creditor), qui a payé
// pour lui : payeur = creditor, part de 1000 portée par l'invité.
const tricountReady = {
  date: "2026-07-10",
  expenses: [
    {
      payerId: "creditor",
      payerGuestId: null,
      isRefund: false,
      shares: [
        { userId: "creditor", guestId: null, amountCents: 0 },
        { userId: null, guestId: "guest1", amountCents: 1000 },
      ],
    },
  ],
  approvals: [{ userId: "creditor" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "creditor" };
  h.guest = { tricountId: "t1" };
  h.tricount = tricountReady;
  h.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "refund1",
    ...args.data,
  }));
});

describe("POST /api/tricount/[id]/refunds — { fromGuestId } (créancier confirme)", () => {
  it("enregistre le remboursement avec l'invité comme payeur (payerGuestId)", async () => {
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1000 }), ctx);
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledTimes(1);
    const data = h.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.payerGuestId).toBe("guest1");
    expect(data.payerId).toBeUndefined();
    expect(data.isRefund).toBe(true);
    expect((data.shares as { create: unknown }).create).toEqual([
      { userId: "creditor", amountCents: 1000 },
    ]);
  });

  it("refuse un invité qui n'appartient pas à CE tricount", async () => {
    h.guest = { tricountId: "AUTRE_TRICOUNT" };
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1000 }), ctx);
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuse un invité introuvable", async () => {
    h.guest = null;
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1000 }), ctx);
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuse si l'invité ne doit rien (solde >= 0)", async () => {
    // Un payeur valide existe (payers/approvals passent), mais l'invité n'apparaît
    // dans aucune part : son solde est 0, pas négatif.
    h.tricount = {
      ...tricountReady,
      expenses: [
        {
          payerId: "creditor",
          payerGuestId: null,
          isRefund: false,
          shares: [{ userId: "creditor", guestId: null, amountCents: 1000 }],
        },
      ],
    };
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1000 }), ctx);
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("plafonne au solde restant dû", async () => {
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1001 }), ctx);
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("exige que tous les payeurs aient validé", async () => {
    h.tricount = { ...tricountReady, approvals: [] };
    const res = await POST(req({ fromGuestId: "guest1", amountCents: 1000 }), ctx);
    expect(res.status).toBe(409);
    expect(h.create).not.toHaveBeenCalled();
  });
});
