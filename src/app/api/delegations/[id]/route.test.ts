import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Les DEUX parties peuvent mettre fin à une délégation : le délégant retire les droits donnés,
// le délégataire rend ceux qu'il a reçus (il n'a rien demandé). Dans les deux cas c'est une
// restriction de droits. Mais on ne touche jamais à la délégation de deux AUTRES membres.

const h = vi.hoisted(() => ({
  session: { userId: "delegant", displayName: "Alice", resa: null } as { userId: string } | null,
  found: null as null | Record<string, unknown>,
  findFirst: vi.fn(),
  update: vi.fn(),
  // Typé : on inspecte le destinataire et le corps de la notif dans les tests.
  push: vi.fn(async (_userId: string, _payload: { title: string; body: string }) => 1),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: false,
    delegation: true,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("@/lib/push", () => ({ pushToUser: h.push }));
vi.mock("@/lib/db", () => ({
  prisma: {
    delegation: { findFirst: h.findFirst, update: h.update },
    user: { findUnique: vi.fn(async () => ({ displayName: "Alice", nickname: null })) },
  },
}));

import { DELETE } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "d1" }) };
const DELEG = { id: "d1", delegatorId: "delegant", delegateId: "delegataire" };

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "delegant" };
  h.findFirst.mockImplementation(async () => DELEG);
});

describe("DELETE /api/delegations/[id]", () => {
  it("le délégant peut révoquer, et le délégataire est prévenu", async () => {
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toBe("delegataire");
    expect(h.push.mock.calls[0][1].body).toMatch(/plus agir en son nom/);
  });

  it("le délégataire peut rendre la délégation, et le délégant est prévenu", async () => {
    h.session = { userId: "delegataire" }; // ← le cas signalé, impossible avant
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toBe("delegant");
    expect(h.push.mock.calls[0][1].body).toMatch(/a rendu la délégation/);
  });

  it("la recherche est bornée aux délégations où je suis partie prenante", async () => {
    await DELETE(req(), ctx);
    const where = h.findFirst.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([{ delegatorId: "delegant" }, { delegateId: "delegant" }]);
  });

  it("un tiers ne révoque rien (aucune ligne ne matche) et n'apprend rien", async () => {
    h.session = { userId: "intrus" };
    h.findFirst.mockImplementation(async () => null);
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200); // réponse identique : pas d'énumération
    expect(h.update).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("refuse un appel non authentifié", async () => {
    h.session = null;
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(401);
  });
});
