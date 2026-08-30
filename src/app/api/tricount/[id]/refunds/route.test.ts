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

// ─────────────────────────────────────────────────────────────────────────────
// LA BRANCHE { toId } — l'auto-déclaration, et le cas ordinaire.
//
// C'est le chemin qu'emprunte tout membre qui déclare avoir remboursé quelqu'un. L'en-tête de
// ce fichier disait « la branche { toId } … est inchangée » : inchangée, mais jamais éprouvée.
//
// Elle porte pourtant le plafond `min(-fromBal, toBal)`, qui est le garde-fou de conservation
// des sommes côté remboursement : sans lui, un membre pourrait « rembourser » plus qu'il ne
// doit, ou plus que l'autre n'a avancé, et faire basculer le tricount dans un solde inventé.
// ─────────────────────────────────────────────────────────────────────────────

/** Alice a payé 30 € pour elle et Bob : Bob doit 15 €, Alice a 15 € à récupérer. */
const aliceAPayePourBob = {
  date: "2026-07-10",
  expenses: [
    {
      payerId: "alice",
      payerGuestId: null,
      isRefund: false,
      shares: [
        { userId: "alice", guestId: null, amountCents: 1500 },
        { userId: "bob", guestId: null, amountCents: 1500 },
      ],
    },
  ],
  approvals: [{ userId: "alice" }],
};

describe("POST /api/tricount/[id]/refunds — { toId } (auto-déclaration)", () => {
  beforeEach(() => {
    h.session = { userId: "bob" }; // le débiteur déclare avoir remboursé
    h.tricount = aliceAPayePourBob;
  });

  it("écrit le déclarant comme payeur et le bénéficiaire comme porteur de la part", async () => {
    const res = await POST(req({ toId: "alice", amountCents: 1500 }), ctx);
    expect(res.status).toBe(201);
    const data = h.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.payerId).toBe("bob");
    expect(data.payerGuestId).toBeUndefined();
    expect(data.creatorId).toBe("bob");
    expect(data.isRefund).toBe(true);
    expect(data.label).toBe("Remboursement");
    expect((data.shares as { create: unknown }).create).toEqual([
      { userId: "alice", amountCents: 1500 },
    ]);
  });

  it("accepte un remboursement PARTIEL", async () => {
    // Rembourser en plusieurs fois est le cas normal : le plafond borne, il n'impose pas.
    const res = await POST(req({ toId: "alice", amountCents: 500 }), ctx);
    expect(res.status).toBe(201);
  });

  it("PLAFONNE au moins des deux soldes, et dit le montant en euros à la française", async () => {
    // Le cœur de la conservation des sommes de cette route : on ne peut rendre ni plus que ce
    // qu'on doit, ni plus que l'autre n'a avancé.
    const res = await POST(req({ toId: "alice", amountCents: 1501 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Montant trop élevé : au plus 15,00 €" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("plafonne au CRÉANCIER quand il a avancé MOINS que le débiteur ne doit", async () => {
    // Les deux soldes doivent borner, pas seulement celui du débiteur. Ici Bob doit 20 € au
    // total, mais Alice n'a avancé que 10 € : lui en rendre 20 la rendrait créancière de 10 €
    // à partir de rien, aux dépens de Charlie. Avec des soldes égaux des deux côtés, ce test
    // ne distinguerait pas `min(-fromBal, toBal)` de `-fromBal` — c'est pourquoi ils diffèrent.
    h.tricount = {
      date: "2026-07-10",
      expenses: [
        // Alice avance 20 € pour elle et Bob → Alice +10, Bob −10
        {
          payerId: "alice",
          payerGuestId: null,
          isRefund: false,
          shares: [
            { userId: "alice", guestId: null, amountCents: 1000 },
            { userId: "bob", guestId: null, amountCents: 1000 },
          ],
        },
        // Charlie avance 20 € pour lui et Bob → Bob −10 de plus, soit −20 en tout
        {
          payerId: "charlie",
          payerGuestId: null,
          isRefund: false,
          shares: [
            { userId: "charlie", guestId: null, amountCents: 1000 },
            { userId: "bob", guestId: null, amountCents: 1000 },
          ],
        },
      ],
      approvals: [{ userId: "alice" }, { userId: "charlie" }],
    };
    const res = await POST(req({ toId: "alice", amountCents: 1500 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Montant trop élevé : au plus 10,00 €" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("plafonne au DÉBITEUR quand il doit MOINS que le créancier n'a avancé", async () => {
    // L'asymétrie inverse de la précédente, et il faut les deux : chacune seule laisserait
    // passer un plafond qui n'aurait retenu qu'un des deux soldes. Ici Alice a avancé 20 € et
    // Bob n'en doit que 10 : lui en rendre 15 le rendrait créancier de 5 € qu'il n'a pas payés.
    h.tricount = {
      date: "2026-07-10",
      expenses: [
        {
          payerId: "alice",
          payerGuestId: null,
          isRefund: false,
          shares: [
            { userId: "alice", guestId: null, amountCents: 1000 },
            { userId: "bob", guestId: null, amountCents: 1000 },
            { userId: "charlie", guestId: null, amountCents: 1000 },
          ],
        },
      ],
      approvals: [{ userId: "alice" }],
    };
    const res = await POST(req({ toId: "alice", amountCents: 1500 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Montant trop élevé : au plus 10,00 €" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuse de rembourser QUELQU'UN QUI N'A RIEN AVANCÉ", async () => {
    // Bob doit bien de l'argent, mais pas à Charlie : sans ce contrôle, le solde de Charlie
    // deviendrait positif à partir de rien.
    const res = await POST(req({ toId: "charlie", amountCents: 100 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Ce membre n'a rien à récupérer sur ce tricount",
    });
  });

  it("refuse quand le DÉCLARANT ne doit rien", async () => {
    h.session = { userId: "alice" }; // Alice est créancière, pas débitrice
    const res = await POST(req({ toId: "bob", amountCents: 100 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Ce débiteur ne doit rien sur ce tricount",
    });
  });

  it("refuse qu'on se rembourse SOI-MÊME", async () => {
    // `toId === session.userId` retombe sur « Bénéficiaire invalide » : un virement de soi à
    // soi ne changerait aucun solde mais gonflerait l'historique.
    const res = await POST(req({ toId: "bob", amountCents: 100 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Bénéficiaire invalide" });
  });

  it("refuse un corps sans bénéficiaire du tout", async () => {
    for (const corps of [{ amountCents: 100 }, { toId: "", amountCents: 100 }, { toId: 42, amountCents: 100 }]) {
      const res = await POST(req(corps), ctx);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Bénéficiaire invalide" });
    }
  });

  it("refuse un montant nul, négatif ou non entier", async () => {
    for (const m of [0, -100, 12.5, "1500"]) {
      const res = await POST(req({ toId: "alice", amountCents: m }), ctx);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Montant invalide" });
    }
  });

  it("exige que TOUS les payeurs aient validé — 409, pas 400", async () => {
    // Le 409 dit « pas maintenant » là où le 400 dirait « pas comme ça » : l'écran s'en sert
    // pour proposer d'attendre plutôt que de corriger la saisie.
    h.tricount = { ...aliceAPayePourBob, approvals: [] };
    const res = await POST(req({ toId: "alice", amountCents: 100 }), ctx);
    expect(res.status).toBe(409);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("répond 404 sur un tricount inconnu", async () => {
    h.tricount = null;
    const res = await POST(req({ toId: "alice", amountCents: 100 }), ctx);
    expect(res.status).toBe(404);
  });
});
