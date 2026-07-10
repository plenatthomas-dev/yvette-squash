import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string; resa?: unknown },
  outgoing: [] as Array<Record<string, unknown>>,
  incoming: [] as Array<Record<string, unknown>>,
  // POST : utilisateurs « trouvés » par prisma.user.findMany + espions de la transaction.
  foundUsers: [] as Array<{ id: string }>,
  // Délégations actives existantes (lues hors transaction, chemin extend).
  activeExisting: [] as Array<{ delegateId: string; expiresAt: Date }>,
  activeFindMany: vi.fn(),
  // Plafond de fonctionnement : échéance de la session ResaMania du délégant.
  sessionExpiry: null as Date | null,
  updateMany: vi.fn(),
  create: vi.fn(),
  pushToUser: vi.fn(),
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_DELEGATION() {
    return h.featureOn;
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async () => h.session),
  getResaSessionExpiry: vi.fn(async () => h.sessionExpiry),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => h.foundUsers),
      findUnique: vi.fn(async () => ({ displayName: "Moi Même", nickname: null })),
    },
    delegation: { findMany: h.activeFindMany },
    // La transaction relaie vers les espions : on vérifie révocation (renouvellement)
    // et créations sans base réelle.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        delegation: { updateMany: h.updateMany, create: h.create },
      }),
    ),
  },
}));
vi.mock("@/lib/push", () => ({ pushToUser: h.pushToUser }));
vi.mock("@/lib/delegation", () => ({
  DELEGATION_DURATIONS_H: [3, 12],
  DELEGATION_SCOPE: "booking",
  getActiveOutgoingDelegations: vi.fn(async () => h.outgoing),
  getActiveIncomingDelegations: vi.fn(async () => h.incoming),
}));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const postReq = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
  }) as unknown as NextRequest;

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1", resa: { token: "t" } };
  h.outgoing = [];
  h.incoming = [];
  h.foundUsers = [];
  h.activeExisting = [];
  h.activeFindMany.mockReset().mockImplementation(async () => h.activeExisting);
  h.sessionExpiry = new Date(Date.now() + 30 * 864e5); // session fraîche par défaut
  h.updateMany.mockReset().mockResolvedValue({ count: 0 });
  h.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: { delegateId: string; expiresAt: Date } }) => ({
      id: `new-${data.delegateId}`,
      delegateId: data.delegateId,
      expiresAt: data.expiresAt,
    }));
  h.pushToUser.mockReset().mockResolvedValue(undefined);
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

  it("renvoie TOUTES les délégations données (tableau, plusieurs délégués)", async () => {
    const d = (dId: string, name: string) => ({
      id: `del-${dId}`,
      delegateId: dId,
      delegate: { id: dId, displayName: name, nickname: null },
      expiresAt: new Date("2026-07-12T12:00:00Z"),
    });
    h.outgoing = [d("a", "Alice Martin"), d("b", "Bruno Durand")];
    const res = await GET(req());
    const body = await res.json();
    expect(Array.isArray(body.outgoing)).toBe(true);
    expect(body.outgoing).toHaveLength(2);
    expect(body.outgoing.map((x: { delegateName: string }) => x.delegateName)).toEqual([
      "Alice Martin",
      "Bruno Durand",
    ]);
    expect(body.outgoing[0]).toMatchObject({ delegateId: "a", id: "del-a" });
  });

  it("outgoing est un tableau vide quand aucune délégation donnée", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.outgoing).toEqual([]);
  });

  it("renvoie l'échéance de MA session ResaMania (plafond des délégations)", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.sessionExpiresAt).toBe(h.sessionExpiry?.toISOString());
  });
});

describe("POST /api/delegations", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await POST(postReq({ delegateIds: ["a"], hours: 3 }))).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(postReq({ delegateIds: ["a"], hours: 3 }))).status).toBe(401);
  });

  it("403 sans session ResaMania (compte email-seul)", async () => {
    h.session = { userId: "u1" }; // pas de resa
    expect((await POST(postReq({ delegateIds: ["a"], hours: 3 }))).status).toBe(403);
  });

  it("400 si aucun membre / entrée non-string", async () => {
    expect((await POST(postReq({ delegateIds: [], hours: 3 }))).status).toBe(400);
    expect((await POST(postReq({ hours: 3 }))).status).toBe(400);
    expect((await POST(postReq({ delegateIds: ["a", 42], hours: 3 }))).status).toBe(400);
    expect((await POST(postReq({ delegateIds: [""], hours: 3 }))).status).toBe(400);
  });

  it("400 si on se délègue à soi-même (y compris au milieu d'une liste)", async () => {
    expect((await POST(postReq({ delegateIds: ["a", "u1"], hours: 3 }))).status).toBe(400);
  });

  it("400 si durée hors des préréglages", async () => {
    h.foundUsers = [{ id: "a" }];
    expect((await POST(postReq({ delegateIds: ["a"], hours: 999 }))).status).toBe(400);
    expect((await POST(postReq({ delegateIds: ["a"], hours: "3" }))).status).toBe(400);
  });

  it("400 au-delà du plafond de membres", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `m${i}`);
    expect((await POST(postReq({ delegateIds: ids, hours: 3 }))).status).toBe(400);
  });

  it("404 si un des membres n'existe pas", async () => {
    h.foundUsers = [{ id: "a" }]; // « b » introuvable
    expect((await POST(postReq({ delegateIds: ["a", "b"], hours: 3 }))).status).toBe(404);
  });

  it("crée UNE délégation par membre choisi + push à chacun", async () => {
    h.foundUsers = [{ id: "a" }, { id: "b" }];
    const res = await POST(postReq({ delegateIds: ["a", "b"], hours: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delegations).toEqual([
      { id: "new-a", delegateId: "a", expiresAt: expect.any(String) },
      { id: "new-b", delegateId: "b", expiresAt: expect.any(String) },
    ]);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.pushToUser).toHaveBeenCalledTimes(2);
    expect(h.pushToUser.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("prolongation (extend) : part de l'échéance ACTUELLE, pas de maintenant", async () => {
    h.foundUsers = [{ id: "a" }];
    const currentEnd = new Date(Date.now() + 50 * 3_600_000); // délégation encore active 50 h
    h.activeExisting = [{ delegateId: "a", expiresAt: currentEnd }];
    const res = await POST(postReq({ delegateIds: ["a"], hours: 12, extend: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Nouvelle échéance = actuelle + 12 h (à la milliseconde près).
    expect(new Date(body.delegations[0].expiresAt).getTime()).toBe(
      currentEnd.getTime() + 12 * 3_600_000,
    );
    // Push de prolongation, pas de « nouvelle délégation ».
    expect(h.pushToUser.mock.calls[0][1].title).toContain("prolongée");
  });

  it("prolongation sans délégation active : retombe sur maintenant + durée", async () => {
    h.foundUsers = [{ id: "a" }];
    h.activeExisting = []; // rien d'actif (expirée entre-temps)
    const before = Date.now();
    const res = await POST(postReq({ delegateIds: ["a"], hours: 12, extend: true }));
    const body = await res.json();
    const end = new Date(body.delegations[0].expiresAt).getTime();
    expect(end).toBeGreaterThanOrEqual(before + 12 * 3_600_000);
    expect(end).toBeLessThan(before + 13 * 3_600_000);
  });

  it("création simple : ne lit PAS les délégations existantes", async () => {
    h.foundUsers = [{ id: "a" }];
    await POST(postReq({ delegateIds: ["a"], hours: 3 }));
    expect(h.activeFindMany).not.toHaveBeenCalled();
  });

  it("409 si l'échéance dépasse la session ResaMania du délégant", async () => {
    h.foundUsers = [{ id: "a" }];
    h.sessionExpiry = new Date(Date.now() + 3_600_000); // session encore valable 1 h
    const res = await POST(postReq({ delegateIds: ["a"], hours: 3 })); // vise +3 h
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Reconnecte-toi");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("409 si la PROLONGATION dépasse la session (échéance actuelle + durée)", async () => {
    h.foundUsers = [{ id: "a" }];
    const currentEnd = new Date(Date.now() + 10 * 3_600_000);
    h.activeExisting = [{ delegateId: "a", expiresAt: currentEnd }];
    h.sessionExpiry = new Date(Date.now() + 15 * 3_600_000); // 10 h + 12 h > 15 h
    const res = await POST(postReq({ delegateIds: ["a"], hours: 12, extend: true }));
    expect(res.status).toBe(409);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("pas de blocage si aucune session ResaMania trouvée (garde-fou ouvert)", async () => {
    h.foundUsers = [{ id: "a" }];
    h.sessionExpiry = null;
    const res = await POST(postReq({ delegateIds: ["a"], hours: 3 }));
    expect(res.status).toBe(200);
  });

  it("renouvellement : révoque l'existante des MÊMES délégués, endNotifiedAt posé", async () => {
    h.foundUsers = [{ id: "a" }, { id: "b" }];
    await POST(postReq({ delegateIds: ["a", "b"], hours: 12 }));
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    const arg = h.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      delegatorId: "u1",
      delegateId: { in: ["a", "b"] },
      revokedAt: null,
    });
    // endNotifiedAt posé → le cron d'expiration ne re-notifiera pas une délégation remplacée.
    expect(arg.data.revokedAt).toBeInstanceOf(Date);
    expect(arg.data.endNotifiedAt).toBeInstanceOf(Date);
  });

  it("dédoublonne les ids répétés (une seule création)", async () => {
    h.foundUsers = [{ id: "a" }];
    const res = await POST(postReq({ delegateIds: ["a", "a"], hours: 3 }));
    expect(res.status).toBe(200);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("rétro-compat : accepte l'ancien { delegateId } mono", async () => {
    h.foundUsers = [{ id: "a" }];
    const res = await POST(postReq({ delegateId: "a", hours: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delegations).toEqual([
      { id: "new-a", delegateId: "a", expiresAt: expect.any(String) },
    ]);
  });
});
