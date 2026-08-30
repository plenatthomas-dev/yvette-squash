import { describe, it, expect } from "vitest";
import {
  roundingCredit,
  splitEqually,
  splitWithCredits,
  splitByWeights,
  payersOf,
  computeBalances,
  settle,
  userKey,
  guestKey,
  parseKey,
  toKeyedExpense,
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

describe("userKey/guestKey/parseKey", () => {
  it("préfixe puis retrouve le type et l'id d'origine", () => {
    expect(parseKey(userKey("abc"))).toEqual({ kind: "user", id: "abc" });
    expect(parseKey(guestKey("abc"))).toEqual({ kind: "guest", id: "abc" });
  });

  it("un membre et un invité de même id brut ne collisionnent jamais", () => {
    expect(userKey("x")).not.toBe(guestKey("x"));
  });
});

describe("toKeyedExpense", () => {
  it("garde un payeur/participant membre inchangé (préfixé u:)", () => {
    const keyed = toKeyedExpense({
      payerId: "a",
      payerGuestId: null,
      isRefund: false,
      shares: [{ userId: "b", guestId: null, amountCents: 100 }],
    });
    expect(keyed).toEqual({
      payerId: "u:a",
      isRefund: false,
      shares: [{ userId: "u:b", amountCents: 100 }],
    });
  });

  it("bascule sur payerGuestId/guestId (préfixé g:) quand userId/payerId sont null", () => {
    const keyed = toKeyedExpense({
      payerId: null,
      payerGuestId: "guest1",
      isRefund: true,
      shares: [{ userId: "creditor", guestId: null, amountCents: 500 }],
    });
    expect(keyed.payerId).toBe("g:guest1");
    expect(keyed.shares).toEqual([{ userId: "u:creditor", amountCents: 500 }]);
  });

  it("un invité participant (part) est keyé g: même sur une vraie dépense", () => {
    const keyed = toKeyedExpense({
      payerId: "payer",
      payerGuestId: null,
      isRefund: false,
      shares: [
        { userId: "member", guestId: null, amountCents: 500 },
        { userId: null, guestId: "guest1", amountCents: 500 },
      ],
    });
    expect(keyed.shares).toEqual([
      { userId: "u:member", amountCents: 500 },
      { userId: "g:guest1", amountCents: 500 },
    ]);
  });

  it("computeBalances/payersOf traitent un invité comme n'importe quelle clé", () => {
    const expenses = [
      toKeyedExpense({
        payerId: "payer",
        payerGuestId: null,
        isRefund: false,
        shares: [
          { userId: "payer", guestId: null, amountCents: 0 },
          { userId: null, guestId: "guest1", amountCents: 1000 },
        ],
      }),
    ];
    const bal = computeBalances(expenses);
    expect(bal.get(userKey("payer"))).toBe(1000);
    expect(bal.get(guestKey("guest1"))).toBe(-1000);
    // Un invité n'est jamais payeur d'une vraie dépense : payersOf ne renvoie que
    // des clés membre.
    expect(payersOf(expenses)).toEqual([userKey("payer")]);
  });
});

describe("roundingCredit — la mémoire des arrondis, éprouvée directement", () => {
  // Elle n'était atteinte qu'à travers deux cas de la route de création : le lecteur qui vient
  // chercher la garantie ici ne trouvait rien, et plusieurs façons de la casser (inverser le
  // sens du tri, changer le seuil de détection du pondéré) ne faisaient tomber aucun test de
  // ce fichier — celui qui prétendait la couvrir réimplémentait sa formule au lieu de l'appeler.
  const part = (userId: string, amountCents: number) => ({ userId, guestId: null, amountCents });

  it("retient qui a surpayé sur un partage égal", () => {
    // 10 € entre 3 → [334, 333, 333] : le premier a payé un tiers de centime de trop.
    const credit = roundingCredit([
      { amountCents: 1000, shares: [part("a", 334), part("b", 333), part("c", 333)] },
    ]);
    // exact = 1000/3 = 333,33… : le premier a reçu 334, soit deux tiers de centime de trop ;
    // les deux autres 333, soit un tiers de trop peu chacun.
    expect(credit.get("u:a")).toBeCloseTo(2 / 3, 6);
    expect(credit.get("u:b")).toBeCloseTo(-1 / 3, 6);
    // La somme des crédits est nulle : personne n'a surpayé sans qu'un autre sous-paie.
    expect([...credit.values()].reduce((s, c) => s + c, 0)).toBeCloseTo(0, 6);
  });

  it("IGNORE une dépense pondérée — elle n'a aucune erreur d'arrondi à léguer", () => {
    // 40 € en [2,1,1] est réparti exactement. La formule `montant / n` y verrait pourtant un
    // écart de ±6,67 € et ±3,33 € : plus une erreur d'arrondi, mais l'écart de PONDÉRATION,
    // qui domine ensuite le tri et envoie le centime suivant au plus petit poids.
    const credit = roundingCredit([
      { amountCents: 4000, shares: [part("a", 2000), part("b", 1000), part("c", 1000)] },
    ]);
    expect(credit.size).toBe(0);
  });

  it("cumule les dépenses ÉGALES et laisse de côté les pondérées du même tricount", () => {
    const credit = roundingCredit([
      { amountCents: 1000, shares: [part("a", 334), part("b", 333), part("c", 333)] },
      { amountCents: 4000, shares: [part("a", 2000), part("b", 1000), part("c", 1000)] },
      { amountCents: 1000, shares: [part("a", 334), part("b", 333), part("c", 333)] },
    ]);
    expect(credit.get("u:a")).toBeCloseTo(4 / 3, 6); // deux fois les deux tiers de centime
    expect(credit.get("u:c")).toBeCloseTo(-2 / 3, 6);
  });

  it("distingue un invité d'un membre de même identifiant", () => {
    const credit = roundingCredit([
      {
        amountCents: 3,
        shares: [
          { userId: "x", guestId: null, amountCents: 2 },
          { userId: null, guestId: "x", amountCents: 1 },
        ],
      },
    ]);
    expect(credit.get("u:x")).toBeCloseTo(0.5, 6);
    expect(credit.get("g:x")).toBeCloseTo(-0.5, 6);
  });

  it("nourrit `splitWithCredits` : 200 € puis 100 € entre 3 font bien 100 € chacun", () => {
    // La promesse annoncée en toutes lettres dans le commentaire de `splitWithCredits`, mais
    // vérifiée ici de bout en bout — mémoire construite par `roundingCredit`, pas par le test.
    const premiere = splitEqually(20000, 3); // [6667, 6667, 6666]
    const credit = roundingCredit([
      {
        amountCents: 20000,
        shares: [part("a", premiere[0]), part("b", premiere[1]), part("c", premiere[2])],
      },
    ]);
    const seconde = splitWithCredits(10000, ["u:a", "u:b", "u:c"], credit);
    expect(seconde.reduce((s, c) => s + c, 0)).toBe(10000);
    // Le centime va à celui qui avait sous-payé, donc chacun aura versé 100,00 € au total.
    expect(premiere.map((p, i) => p + seconde[i])).toEqual([10000, 10000, 10000]);
  });

  it("ne jette pas sur une dépense sans part", () => {
    expect(roundingCredit([{ amountCents: 100, shares: [] }]).size).toBe(0);
  });
});
