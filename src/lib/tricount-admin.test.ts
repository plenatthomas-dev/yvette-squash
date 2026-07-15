import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as unknown[], deleteMany: vi.fn() }));

vi.mock("./db", () => ({
  prisma: {
    tricount: {
      findMany: vi.fn(async () => h.rows),
      deleteMany: h.deleteMany,
    },
  },
}));

import { listTricountsAdmin, deleteTricount } from "./tricount-admin";

beforeEach(() => {
  h.rows = [];
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
});

describe("deleteTricount", () => {
  it("supprime par id (cascade côté DB)", async () => {
    await deleteTricount("t1");
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { id: "t1" } });
  });
});
