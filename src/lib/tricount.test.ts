import { describe, it, expect } from "vitest";
import {
  splitEqually,
  splitWithCredits,
  splitByWeights,
  payersOf,
  computeBalances,
  settle,
  type ExpenseForBalance,
} from "./tricount";

// Invariant transversal à toute cette logique d'argent : on ne perd ni n'invente
// jamais un centime. La somme des parts doit toujours valoir exactement le montant.
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("splitEqually", () => {
  it("répartit exactement, reste au(x) premier(s)", () => {
    expect(splitEqually(100, 3)).toEqual([34, 33, 33]);
    expect(splitEqually(90, 3)).toEqual([30, 30, 30]);
    expect(splitEqually(0, 3)).toEqual([0, 0, 0]);
    expect(splitEqually(2, 5)).toEqual([1, 1, 0, 0, 0]);
  });

  it("la somme vaut toujours le montant (fuzz)", () => {
    for (let amount = 0; amount < 500; amount++) {
      for (let n = 1; n <= 7; n++) {
        expect(sum(splitEqually(amount, n))).toBe(amount);
      }
    }
  });
});

describe("splitWithCredits", () => {
  it("sans crédit, se comporte comme splitEqually (ordre des ids)", () => {
    const parts = splitWithCredits(100, ["a", "b", "c"], new Map());
    expect(sum(parts)).toBe(100);
    // Départage déterministe par id : a et b (les plus petits) prennent le centime.
    expect(parts).toEqual([34, 33, 33]);
  });

  it("les centimes en trop vont à ceux qui ont le moins surpayé", () => {
    // a a déjà surpayé de 2 centimes : il doit être servi en dernier.
    const credit = new Map([["a", 2]]);
    const parts = splitWithCredits(100, ["a", "b", "c"], credit);
    expect(sum(parts)).toBe(100);
    expect(parts[0]).toBe(33); // a n'a PAS le centime en trop
  });

  it("compense les arrondis d'une dépense à l'autre : 200 puis 100 entre 3 => 100 chacun", () => {
    const ids = ["a", "b", "c"];
    const credit = new Map<string, number>();
    const exact = (amount: number, n: number) => amount / n;

    const step = (amount: number) => {
      const parts = splitWithCredits(amount, ids, credit);
      const ex = exact(amount, ids.length);
      ids.forEach((id, i) => credit.set(id, (credit.get(id) ?? 0) + (parts[i] - ex)));
      return parts;
    };

    const first = step(20000); // 200 €
    const second = step(10000); // 100 €
    const total = ids.map((_, i) => first[i] + second[i]);
    expect(total).toEqual([10000, 10000, 10000]); // 100 € pile chacun
  });
});

describe("splitByWeights", () => {
  it("répartit selon les parts : 40 € en [1,2,1] => [10,20,10]", () => {
    expect(splitByWeights(4000, ["a", "b", "c"], [1, 2, 1])).toEqual([1000, 2000, 1000]);
  });

  it("plus grand reste, départage par index, somme exacte", () => {
    const parts = splitByWeights(100, ["a", "b", "c"], [1, 1, 1]);
    expect(sum(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("total des poids nul => retombe sur un partage égal", () => {
    expect(splitByWeights(100, ["a", "b", "c"], [0, 0, 0])).toEqual(splitEqually(100, 3));
  });

  it("somme exacte (fuzz sur poids aléatoires)", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 5;
    for (let t = 0; t < 300; t++) {
      const n = 1 + (t % 6);
      const ids = Array.from({ length: n }, (_, i) => `u${i}`);
      const weights = ids.map(() => 1 + rnd());
      const amount = (t * 137) % 9999;
      expect(sum(splitByWeights(amount, ids, weights))).toBe(amount);
    }
  });
});

describe("payersOf", () => {
  it("liste les payeurs de vraies dépenses, sans doublon, ignore les remboursements", () => {
    const expenses: ExpenseForBalance[] = [
      { payerId: "a", shares: [{ userId: "a", amountCents: 50 }] },
      { payerId: "a", shares: [{ userId: "b", amountCents: 50 }] },
      { payerId: "b", shares: [{ userId: "c", amountCents: 50 }] },
      { payerId: "c", isRefund: true, shares: [{ userId: "a", amountCents: 50 }] },
    ];
    expect(payersOf(expenses).sort()).toEqual(["a", "b"]);
  });
});

describe("computeBalances", () => {
  it("solde net = avancé − dû, somme nulle", () => {
    // a paie 90 €, partagé également entre a, b, c (30 chacun).
    const expenses: ExpenseForBalance[] = [
      {
        payerId: "a",
        shares: [
          { userId: "a", amountCents: 3000 },
          { userId: "b", amountCents: 3000 },
          { userId: "c", amountCents: 3000 },
        ],
      },
    ];
    const bal = computeBalances(expenses);
    expect(bal.get("a")).toBe(6000); // a avance 90, doit 30 => +60
    expect(bal.get("b")).toBe(-3000);
    expect(bal.get("c")).toBe(-3000);
    expect(sum([...bal.values()])).toBe(0);
  });

  it("un remboursement rapproche les soldes de zéro", () => {
    const expenses: ExpenseForBalance[] = [
      {
        payerId: "a",
        shares: [
          { userId: "a", amountCents: 0 },
          { userId: "b", amountCents: 6000 },
        ],
      },
      // b rembourse a : b paie, part attribuée à a.
      { payerId: "b", isRefund: true, shares: [{ userId: "a", amountCents: 6000 }] },
    ];
    const bal = computeBalances(expenses);
    expect(bal.get("a")).toBe(0);
    expect(bal.get("b")).toBe(0);
  });
});

describe("settle", () => {
  it("propose des virements qui soldent tout le monde", () => {
    const bal = new Map([
      ["a", 6000],
      ["b", -3000],
      ["c", -3000],
    ]);
    const transfers = settle(bal);
    // Chaque débiteur rend 30 € à a.
    expect(sum(transfers.map((t) => t.amountCents))).toBe(6000);
    for (const t of transfers) expect(t.toId).toBe("a");
    // Après application, tous les soldes sont nuls.
    const after = new Map(bal);
    for (const t of transfers) {
      after.set(t.fromId, (after.get(t.fromId) ?? 0) + t.amountCents);
      after.set(t.toId, (after.get(t.toId) ?? 0) - t.amountCents);
    }
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });

  it("au plus n−1 virements et résultat déterministe", () => {
    const bal = new Map([
      ["a", 5000],
      ["b", 3000],
      ["c", -4000],
      ["d", -4000],
    ]);
    const t1 = settle(bal);
    const t2 = settle(new Map(bal));
    expect(t1.length).toBeLessThanOrEqual(3); // n−1
    expect(t1).toEqual(t2); // déterministe
  });

  it("solde déjà nul => aucun virement", () => {
    expect(settle(new Map([["a", 0], ["b", 0]]))).toEqual([]);
  });
});
