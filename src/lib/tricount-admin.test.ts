import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  deleteMany: vi.fn(),
  /** Les options réellement passées au findMany : tri et borne. */
  args: null as null | Record<string, unknown>,
}));

vi.mock("./db", () => ({
  prisma: {
    tricount: {
      // Le mock HONORE `orderBy` et `take` : rendre les lignes sans les regarder revenait à
      // trier et borner À LA PLACE de la requête — retirer l'un ou l'autre ne se voyait pas.
      findMany: vi.fn(async (a: Record<string, unknown>) => {
        h.args = a;
        const tri = (a.orderBy as { date?: string } | undefined)?.date;
        const rows = tri === "desc"
          ? [...(h.rows as { date: string }[])].sort((x, y) => (x.date < y.date ? 1 : -1))
          : h.rows;
        return typeof a.take === "number" ? rows.slice(0, a.take) : rows;
      }),
      deleteMany: h.deleteMany,
    },
  },
}));

import { listTricountsAdmin, deleteTricount } from "./tricount-admin";

beforeEach(() => {
  h.rows = [];
  h.args = null;
  h.deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("listTricountsAdmin (agrégats)", () => {
  it("exclut les remboursements du total et du compte de dépenses", async () => {
    h.rows = [
      {
        id: "t1",
        date: "2026-07-10",
        title: "Repas",
        createdAt: new Date("2026-07-10T20:00:00Z"),
        expenses: [
          { amountCents: 3000, isRefund: false, payerId: "a", shares: [{ userId: "a" }, { userId: "b" }] },
          { amountCents: 1000, isRefund: false, payerId: "b", shares: [{ userId: "b" }, { userId: "c" }] },
          // Remboursement : ne compte NI dans le total NI dans le nb de dépenses.
          { amountCents: 500, isRefund: true, payerId: "c", shares: [{ userId: "a" }] },
        ],
      },
    ];
    const [t] = await listTricountsAdmin();
    expect(t.totalCents).toBe(4000); // 3000 + 1000, le remboursement 500 exclu
    expect(t.expenseCount).toBe(2);
    // Participants distincts : payeurs a,b,c + parts a,b,c = 3
    expect(t.participantCount).toBe(3);
    expect(t.createdAt).toBe("2026-07-10T20:00:00.000Z");
  });

  it("tricount vide → 0 partout", async () => {
    h.rows = [{ id: "t2", date: "2026-07-11", title: null, createdAt: new Date(), expenses: [] }];
    const [t] = await listTricountsAdmin();
    expect(t).toMatchObject({ totalCents: 0, expenseCount: 0, participantCount: 0 });
  });

  it("compte un invité hors asso (payerId/userId null) sans planter", async () => {
    h.rows = [
      {
        id: "t3",
        date: "2026-07-12",
        title: null,
        createdAt: new Date("2026-07-12T20:00:00Z"),
        expenses: [
          {
            amountCents: 2000,
            isRefund: false,
            payerId: "a",
            payerGuestId: null,
            shares: [
              { userId: "a", guestId: null },
              { userId: null, guestId: "guest1" },
            ],
          },
          // Remboursement déclaré par le créancier "a" pour le compte de l'invité :
          // payeur = l'invité (payerId null), bénéficiaire = "a".
          {
            amountCents: 1000,
            isRefund: true,
            payerId: null,
            payerGuestId: "guest1",
            shares: [{ userId: "a", guestId: null }],
          },
        ],
      },
    ];
    const [t] = await listTricountsAdmin();
    // Participants distincts : a (payeur + part remboursement) + guest1 (part + payeur remboursement) = 2
    expect(t.participantCount).toBe(2);
  });
});

describe("deleteTricount", () => {
  it("supprime par id (cascade côté DB)", async () => {
    await deleteTricount("t1");
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { id: "t1" } });
  });
});

describe("listTricountsAdmin — l'ordre et la borne de la lecture", () => {
  const ligne = (date: string) => ({
    id: date,
    date,
    title: null,
    createdAt: new Date("2026-01-01"),
    expenses: [],
  });

  it("demande les plus RÉCENTS d'abord — le tri est dans la requête, pas dans le test", async () => {
    // Le mock honore `orderBy` exprès : sans cela, retirer le tri de la requête laissait le
    // test vert, et « Charger l'historique plus ancien » aurait découpé une fenêtre arbitraire.
    h.rows = [ligne("2026-08-01"), ligne("2026-09-10"), ligne("2026-08-20")];
    const rows = await listTricountsAdmin();
    expect(rows.map((r) => r.date)).toEqual(["2026-09-10", "2026-08-20", "2026-08-01"]);
    expect(h.args).toMatchObject({ orderBy: { date: "desc" } });
  });

  it("BORNE la lecture : elle inclut les dépenses et leurs parts, son coût ne peut pas croître sans fin", async () => {
    h.rows = Array.from({ length: 250 }, (_, i) => ligne(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`));
    const rows = await listTricountsAdmin();
    expect(h.args?.take).toBe(100);
    expect(rows).toHaveLength(100);
  });
});
