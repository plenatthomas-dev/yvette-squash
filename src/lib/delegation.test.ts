import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AppSession } from "./session";

// resolveActingContext est LE portail de sécurité de la délégation : c'est lui qui décide
// si une requête « au nom de » est couverte, et avec quel jeton elle agit. On le teste
// isolément (book/cancel-slot/bookings ne font que consommer son résultat).

const h = vi.hoisted(() => ({
  featureOn: true,
  // Délégation renvoyée par prisma.delegation.findFirst (findActiveDelegation).
  activeDelegation: null as null | Record<string, unknown>,
  findFirst: vi.fn(),
  // Jeton ResaMania du délégant (getResaTokenForUser).
  delegatorResa: null as null | Record<string, unknown>,
}));

// Le flag est résolu à chaud côté serveur (env + override en base) : on mocke l'état effectif.
vi.mock("./features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: false,
    delegation: h.featureOn,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("./db", () => ({ prisma: { delegation: { findFirst: h.findFirst } } }));
vi.mock("./session", () => ({ getResaTokenForUser: vi.fn(async () => h.delegatorResa) }));

import { resolveActingContext, isDelegationActive } from "./delegation";

const RESA_ME = { accessToken: "tok-me" } as never;
const me: AppSession = { userId: "me", displayName: "Moi", resa: RESA_ME };
const meEmailOnly: AppSession = { userId: "me", displayName: "Moi", resa: null };
const MSG = "La réservation nécessite une connexion ResaMania.";

beforeEach(() => {
  h.featureOn = true;
  h.activeDelegation = { id: "del-1" };
  h.findFirst.mockReset().mockImplementation(async () => h.activeDelegation);
  h.delegatorResa = { accessToken: "tok-delegant" };
});

describe("resolveActingContext — chemin normal (sans onBehalfOf)", () => {
  it("agit avec SA session : propriétaire = moi, actingUserId null", async () => {
    const r = await resolveActingContext(me, undefined, MSG);
    expect(r).toEqual({
      ok: true,
      ctx: { resa: RESA_ME, bookingOwnerId: "me", actingUserId: null },
    });
  });

  it("403 avec le message fourni si session sans ResaMania (email seul)", async () => {
    const r = await resolveActingContext(meEmailOnly, undefined, MSG);
    expect(r).toEqual({ ok: false, status: 403, error: MSG });
  });

  it("un onBehalfOf non-string est ignoré (chemin normal)", async () => {
    const r = await resolveActingContext(me, 42, MSG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.bookingOwnerId).toBe("me");
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});

describe("resolveActingContext — au nom d'un délégant (onBehalfOf)", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    const r = await resolveActingContext(me, "delegator", MSG);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("400 si onBehalfOf = soi-même", async () => {
    const r = await resolveActingContext(me, "me", MSG);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("403 si aucune délégation active ne couvre le couple délégant/délégué", async () => {
    h.activeDelegation = null;
    const r = await resolveActingContext(me, "delegator", MSG);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("cherche la délégation dans le BON sens : delegator → moi (délégué)", async () => {
    await resolveActingContext(me, "delegator", MSG);
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ delegatorId: "delegator", delegateId: "me" }),
      }),
    );
  });

  it("409 si le jeton ResaMania du délégant est irrécupérable", async () => {
    h.delegatorResa = null;
    const r = await resolveActingContext(me, "delegator", MSG);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("succès : agit avec le jeton du DÉLÉGANT, propriétaire = délégant, trace = moi", async () => {
    const r = await resolveActingContext(me, "delegator", MSG);
    expect(r).toEqual({
      ok: true,
      ctx: {
        resa: h.delegatorResa,
        bookingOwnerId: "delegator",
        actingUserId: "me",
      },
    });
  });

  it("délégation exigée même si MA session ResaMania est valide", async () => {
    // Le jeton utilisé doit être celui du délégant, jamais le mien « par défaut ».
    h.activeDelegation = null;
    const r = await resolveActingContext(me, "delegator", MSG);
    expect(r.ok).toBe(false);
  });
});

describe("isDelegationActive", () => {
  const future = new Date(Date.now() + 3_600_000);
  const past = new Date(Date.now() - 1);

  it("active : ni révoquée ni expirée", () => {
    expect(isDelegationActive({ revokedAt: null, expiresAt: future })).toBe(true);
  });

  it("inactive si révoquée (même non expirée)", () => {
    expect(isDelegationActive({ revokedAt: new Date(), expiresAt: future })).toBe(false);
  });

  it("inactive si expirée", () => {
    expect(isDelegationActive({ revokedAt: null, expiresAt: past })).toBe(false);
  });
});
