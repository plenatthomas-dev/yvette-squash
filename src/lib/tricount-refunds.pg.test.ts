// LE PLAFOND DE REMBOURSEMENT SOUS VRAIE CONCURRENCE — la garantie la plus exposée.
//
// `refunds/route.ts` l'écrit en toutes lettres : « Tout ce qui touche au solde (relecture des
// dépenses → vérif du plafond → insertion) doit être ATOMIQUE, sinon deux remboursements
// simultanés lisent le même solde et le dépassent à eux deux. »
//
// Aucun test ne le vérifiait. Le faux client des tests unitaires exécute le corps directement
// et ignore le second argument de `$transaction` : on pouvait remplacer `serializableTransaction`
// par une transaction ordinaire sans faire rougir un seul des seize tests. Et la panne, ici, est
// plus lourde que celle d'`approve` : ce n'est pas une notification perdue, c'est de l'argent
// inventé — un solde qui passe du bon côté de zéro.
//
// ⚠️ CE FICHIER IMPORTE LA ROUTE, il ne la recopie pas.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import type { NextRequest } from "next/server";

// La session se déduit du COOKIE : deux appels lancés en parallèle doivent pouvoir porter deux
// membres différents (un objet partagé serait réassigné avant que la route ne le lise).
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async (sid: string) => ({ userId: sid, displayName: sid, resa: {} })),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: true }) }));

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;
let POST: typeof import("@/app/api/tricount/[id]/refunds/route").POST;

const MARQUEUR = "PG-TEST-tricount-refunds";
let creancier = "";
let debiteur = "";
let tricountId = "";

const req = (userId: string, body: unknown) =>
  ({
    cookies: { get: () => ({ value: userId }) },
    json: async () => body,
  }) as unknown as NextRequest;

/** `debiteur` déclare avoir rendu `cents` à `creancier`, via la vraie route. */
const rembourser = (cents: number) =>
  POST(req(debiteur, { toId: creancier, amountCents: cents }), {
    params: Promise.resolve({ id: tricountId }),
  });

/** Le solde du débiteur, recalculé depuis la base. */
async function soldeDebiteur(): Promise<number> {
  const avances = await prisma.expense.aggregate({
    where: { tricountId, payerId: debiteur },
    _sum: { amountCents: true },
  });
  const parts = await prisma.expenseShare.aggregate({
    where: { userId: debiteur, expense: { tricountId } },
    _sum: { amountCents: true },
  });
  return (avances._sum.amountCents ?? 0) - (parts._sum.amountCents ?? 0);
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — le plafond de remboursement", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ POST } = await import("@/app/api/tricount/[id]/refunds/route"));

    const [a, b] = await Promise.all([
      prisma.user.create({ data: { displayName: `${MARQUEUR} créancier` } }),
      prisma.user.create({ data: { displayName: `${MARQUEUR} débiteur` } }),
    ]);
    creancier = a.id;
    debiteur = b.id;

    // Le créancier a avancé 30 € pour deux : le débiteur lui doit 15 €, et le seul payeur
    // (le créancier) a validé — les remboursements sont donc ouverts.
    const t = await prisma.tricount.create({ data: { date: "2026-10-01" } });
    tricountId = t.id;
    await prisma.expense.create({
      data: {
        tricountId,
        payerId: creancier,
        creatorId: creancier,
        label: "Repas",
        amountCents: 3000,
        spentAt: new Date("2026-10-01T12:00:00"),
        shares: {
          create: [
            { userId: creancier, amountCents: 1500 },
            { userId: debiteur, amountCents: 1500 },
          ],
        },
      },
    });
    await prisma.tricountApproval.create({ data: { tricountId, userId: creancier } });
  }, 60_000);

  afterAll(async () => {
    if (!tricountId) return;
    await prisma.tricount.deleteMany({ where: { id: tricountId } });
    await prisma.user.deleteMany({ where: { id: { in: [creancier, debiteur] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.expense.deleteMany({ where: { tricountId, isRefund: true } });
  });

  it("DEUX remboursements simultanés de 15 € ne rendent jamais 30 € — dix fois de suite", async () => {
    // Le double-clic, la double soumission, ou simplement deux onglets. Sans atomicité, les
    // deux lisent le même solde de −15 €, tous deux le jugent suffisant, et le débiteur se
    // retrouve créancier de 15 € qu'il n'a jamais avancés.
    for (let tour = 1; tour <= 10; tour++) {
      await prisma.expense.deleteMany({ where: { tricountId, isRefund: true } });

      const [ra, rb] = await Promise.all([rembourser(1500), rembourser(1500)]);
      const statuts = [ra.status, rb.status].sort();

      // L'un passe, l'autre est refusé — en 400 (« montant trop élevé », le solde est déjà à
      // zéro) ou en 409 si la boucle de réessai a épuisé ses tentatives. Jamais deux 201.
      expect(statuts[0], `tour ${tour}`).toBe(201);
      expect(statuts[1], `tour ${tour}`).not.toBe(201);

      // Le seul invariant qui compte : le solde ne franchit pas zéro.
      expect(await soldeDebiteur(), `tour ${tour}`).toBe(0);
      const rembourses = await prisma.expense.aggregate({
        where: { tricountId, isRefund: true },
        _sum: { amountCents: true },
      });
      expect(rembourses._sum.amountCents, `tour ${tour}`).toBe(1500);
    }
  }, 60_000);

  it("deux remboursements PARTIELS simultanés tiennent aussi dans le plafond", async () => {
    // Cas plus fin : chacun est valide isolément, et leur somme l'est aussi. Les deux doivent
    // donc passer — le plafond borne, il n'interdit pas de rembourser en plusieurs fois.
    const [ra, rb] = await Promise.all([rembourser(700), rembourser(800)]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(await soldeDebiteur()).toBe(0);
  }, 30_000);

  it("refuse de dépasser le solde, même seul", async () => {
    const res = await rembourser(1501);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Montant trop élevé : au plus 15,00 €" });
  }, 30_000);
});

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("le plafond de remboursement n'est pas vérifié sous concurrence sans base", () => {
    expect(SANS_BASE).toBe(true);
  });
});
