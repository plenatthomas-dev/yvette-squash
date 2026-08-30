import { describe, it, expect, beforeEach, vi } from "vitest";

// LE TOTAL QUI NE MENT PLUS.
//
// « Tu dois X au total » et le badge € se calculaient sur la liste reçue — 25 tricounts, deux
// mois au rythme du club. Une dette plus ancienne sortait de la fenêtre : l'en-tête annonçait
// « Tu es à l'équilibre 👌 » à quelqu'un qui devait toujours 42 €, et le badge disparaissait
// avec elle. Rien ne le signalait, et c'est le propre de ce défaut-là : un total faux ne lève
// aucune erreur, il rassure.
//
// Ce module répond aux deux chiffres par des requêtes ÉTROITES — mes dépenses, mes parts —
// au lieu de l'historique complet avec ses commentaires et ses invités. Les tests portent donc
// sur deux choses : l'exactitude du solde, et le fait que le compte de dettes n'ouvre les
// remboursements que là où tous les payeurs ont validé.

const h = vi.hoisted(() => ({
  /** Dépenses dont JE suis le payeur. */
  avances: [] as { tricountId: string; amountCents: number }[],
  /** Parts qui portent MON nom. */
  parts: [] as { amountCents: number; expense: { tricountId: string } }[],
  /** Payeurs par tricount, tels que la base les rend (lignes distinctes). */
  payeurs: [] as { tricountId: string; payerId: string }[],
  validations: [] as { tricountId: string; userId: string }[],
  /** Les tricounts pour lesquels on est allé chercher payeurs et validations. */
  interroges: null as null | string[],
}));

vi.mock("./db", () => ({
  prisma: {
    expense: {
      // On distingue les deux appels par `tricountId` et non par `payerId` : la requête des
      // payeurs porte elle aussi un `payerId` (`{ not: null }`), et s'en servir renvoyait mes
      // avances à sa place — deux tests tombaient sans que le module soit en cause.
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
        if (!a.where.tricountId) return h.avances;
        h.interroges = (a.where.tricountId as { in: string[] }).in;
        return h.payeurs;
      }),
    },
    expenseShare: { findMany: vi.fn(async () => h.parts) },
    tricountApproval: { findMany: vi.fn(async () => h.validations) },
  },
}));

import { tricountSummary } from "./tricount-summary";

beforeEach(() => {
  vi.clearAllMocks();
  h.avances = [];
  h.parts = [];
  h.payeurs = [];
  h.validations = [];
  h.interroges = null;
});

describe("tricountSummary — le solde global", () => {
  it("rend zéro quand je n'ai rien avancé ni rien dû", async () => {
    expect(await tricountSummary("moi")).toEqual({ globalCents: 0, owedCount: 0 });
  });

  it("soustrait mes parts de ce que j'ai avancé", async () => {
    // J'ai payé 30 € pour deux, donc j'ai avancé 30 et je dois 15 : solde +15.
    h.avances = [{ tricountId: "t1", amountCents: 3000 }];
    h.parts = [{ amountCents: 1500, expense: { tricountId: "t1" } }];
    expect((await tricountSummary("moi")).globalCents).toBe(1500);
  });

  it("SOMME SUR TOUT L'HISTORIQUE, sans se soucier d'aucune fenêtre", async () => {
    // Le cœur du correctif : une dette dans un tricount ancien compte autant qu'une récente.
    h.avances = [{ tricountId: "recent", amountCents: 1000 }];
    h.parts = [
      { amountCents: 1000, expense: { tricountId: "recent" } },
      { amountCents: 4200, expense: { tricountId: "tres-vieux" } },
    ];
    expect((await tricountSummary("moi")).globalCents).toBe(-4200);
  });

  it("laisse les tricounts soldés à zéro sans avoir besoin de les reconnaître", async () => {
    // Un tricount soldé a tous ses soldes à zéro — c'est la définition. Il n'ajoute donc rien
    // à la somme, et il est inutile de savoir lesquels le sont pour que le total soit juste.
    h.avances = [{ tricountId: "solde", amountCents: 1000 }];
    h.parts = [{ amountCents: 1000, expense: { tricountId: "solde" } }];
    expect((await tricountSummary("moi")).globalCents).toBe(0);
  });
});

describe("tricountSummary — le compte de dettes (le badge €)", () => {
  /** Je dois 15 € sur `t1`, dont u1 est le seul payeur. */
  function jeDoisSur(tricountId: string, payeurs: string[]) {
    h.parts.push({ amountCents: 1500, expense: { tricountId } });
    for (const p of payeurs) h.payeurs.push({ tricountId, payerId: p });
  }

  it("compte un tricount où je dois ET où tous les payeurs ont validé", async () => {
    jeDoisSur("t1", ["u1"]);
    h.validations = [{ tricountId: "t1", userId: "u1" }];
    expect((await tricountSummary("moi")).owedCount).toBe(1);
  });

  it("ne compte PAS un tricount dont un payeur n'a pas encore validé", async () => {
    // Le badge dit « des remboursements t'attendent », pas « tu dois de l'argent ».
    jeDoisSur("t1", ["u1", "u2"]);
    h.validations = [{ tricountId: "t1", userId: "u1" }];
    expect((await tricountSummary("moi")).owedCount).toBe(0);
  });

  it("ne compte PAS un tricount SANS PAYEUR — même règle que la liste", async () => {
    // Sans payeur, « tous les payeurs ont validé » serait vrai par vacuité.
    jeDoisSur("t1", []);
    expect((await tricountSummary("moi")).owedCount).toBe(0);
  });

  it("ne compte PAS un tricount où je suis créancier", async () => {
    h.avances = [{ tricountId: "t1", amountCents: 3000 }];
    h.parts = [{ amountCents: 1500, expense: { tricountId: "t1" } }];
    h.payeurs = [{ tricountId: "t1", payerId: "moi" }];
    h.validations = [{ tricountId: "t1", userId: "moi" }];
    expect((await tricountSummary("moi")).owedCount).toBe(0);
  });

  it("N'INTERROGE payeurs et validations que pour les tricounts où je suis à découvert", async () => {
    // La décision de coût de ce module : la question « les remboursements sont-ils ouverts ? »
    // ne se pose que là où j'ai une dette. Sur un historique de deux ans, c'est une poignée
    // de tricounts au lieu de tous.
    h.avances = [{ tricountId: "equilibre", amountCents: 1000 }];
    h.parts = [
      { amountCents: 1000, expense: { tricountId: "equilibre" } },
      { amountCents: 1500, expense: { tricountId: "je-dois" } },
    ];
    await tricountSummary("moi");
    expect(h.interroges).toEqual(["je-dois"]);
  });

  it("n'interroge RIEN quand je ne dois nulle part", async () => {
    h.avances = [{ tricountId: "t1", amountCents: 1000 }];
    await tricountSummary("moi");
    expect(h.interroges).toBeNull();
  });
});
