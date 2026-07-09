import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  outgoing: null as null | Record<string, unknown>,
  incoming: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_DELEGATION() {
    return h.featureOn;
  },
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/push", () => ({ pushToUser: vi.fn() }));
vi.mock("@/lib/delegation", () => ({
  DELEGATION_DURATIONS_H: [3, 12],
  DELEGATION_SCOPE: "booking",
  getActiveOutgoingDelegation: vi.fn(async () => h.outgoing),
  getActiveIncomingDelegations: vi.fn(async () => h.incoming),
}));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.outgoing = null;
  h.incoming = [];
});

describe("GET /api/delegations", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie TOUTES les délégations reçues (tableau, plusieurs délégants)", async () => {
    const d = (dId: string, name: string) => ({
      id: `del-${dId}`,
      delegatorId: dId,
      delegator: { id: dId, displayName: name, nickname: null },
      expiresAt: new Date("2026-07-10T12:00:00Z"),
    });
    h.incoming = [d("a", "Alice Martin"), d("b", "Bruno Durand")];
    const res = await GET(req());
    const body = await res.json();
    expect(Array.isArray(body.incoming)).toBe(true);
    expect(body.incoming).toHaveLength(2);
    expect(body.incoming.map((x: { delegatorName: string }) => x.delegatorName)).toEqual([
      "Alice Martin",
      "Bruno Durand",
    ]);
    expect(body.incoming[0]).toMatchObject({ delegatorId: "a", id: "del-a" });
  });

  it("incoming est un tableau vide quand aucune délégation reçue", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.incoming).toEqual([]);
  });
});
