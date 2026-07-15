import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un compte « email seul » a le droit de DÉCLARER un remboursement (route refunds) — il doit
// donc pouvoir le défaire, d'autant que PATCH lui dit « supprime-le et refais-le ». Seules les
// vraies dépenses lui restent interdites.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  expense: null as null | Record<string, unknown>,
  del: vi.fn(),
  approvalsDeleteMany: vi.fn(),
  count: vi.fn(async () => 1),
  tricountDelete: vi.fn(),
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
    expense: { findUnique: vi.fn(async () => h.expense) },
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        expense: { delete: h.del, count: h.count },
        tricountApproval: { deleteMany: h.approvalsDeleteMany },
        tricount: { delete: h.tricountDelete },
      }),
  },
}));

import { DELETE } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "e1" }) };
/** Session « email seul » = aucun jeton ResaMania (resa null). */
const emailOnly = { userId: "u1", displayName: "Membre", resa: null };
const resaUser = { userId: "u1", displayName: "Membre", resa: { accessToken: "t" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.session = emailOnly;
  h.expense = { tricountId: "t1", isRefund: true, creatorId: "u1", payerId: "u1" };
});

describe("DELETE /api/tricount/expenses/[id] — compte « email seul »", () => {
  it("peut supprimer SON remboursement (le bug signalé)", async () => {
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledTimes(1);
  });

  it("ne peut toujours PAS supprimer une vraie dépense", async () => {
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(403);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("ne peut pas supprimer le remboursement d'un AUTRE (404, pas 403)", async () => {
    h.expense = { tricountId: "t1", isRefund: true, creatorId: "u2", payerId: "u2" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tricount/expenses/[id] — compte ResaMania", () => {
  it("supprime une vraie dépense et remet à zéro les validations", async () => {
    h.session = resaUser;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.approvalsDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("supprimer un remboursement ne remet PAS les validations à zéro", async () => {
    h.session = resaUser;
    await DELETE(req(), ctx);
    expect(h.approvalsDeleteMany).not.toHaveBeenCalled();
  });
});
