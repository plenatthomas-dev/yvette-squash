// « LES REMBOURSEMENTS SONT OUVERTS » NE PART QU'UNE FOIS — la VRAIE route, sur une vraie base.
//
// La route `POST /api/tricount/{id}/approve` décidait cette transition sur une lecture faite
// AVANT l'écriture, hors transaction. Deux payeurs qui validaient au même instant lisaient tous
// deux « aucune validation », concluaient tous deux « pas encore prêt », et le tricount devenait
// prêt sans que PERSONNE ne soit prévenu. Le défaut est silencieux : rien n'échoue, tout le
// monde attend simplement une notification qui ne partira plus.
//
// ⚠️ CE FICHIER IMPORTE LA ROUTE, il ne la recopie pas. Une version antérieure reproduisait le
// corps de la transaction dans une fonction locale : elle prouvait que Postgres attrape le
// write-skew, jamais que la route s'en sert. On pouvait retirer la garde de la route sans faire
// rougir un seul test. Ce qu'on mesure ici, ce sont les `pushToUser` qui partent, pour de vrai,
// au bout de la vraie route.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ push: vi.fn(async () => {}) }));

// La session se déduit du COOKIE, comme la vraie. Un objet partagé réassigné avant chaque appel
// ne tiendrait pas : `POST` suspend sur `getFeatures()` AVANT de lire la session, donc deux
// appels lancés en parallèle liraient tous deux la dernière valeur posée. Le test enregistrait
// alors deux validations du MÊME membre et accusait la route à tort — c'est le test qui était
// faux, pas elle.
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async (sid: string) => ({ userId: sid, displayName: sid, resa: {} })),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: true }) }));
vi.mock("@/lib/push", () => ({ pushToUser: h.push }));

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;
let POST: typeof import("@/app/api/tricount/[id]/approve/route").POST;

const MARQUEUR = "PG-TEST-tricount-approve";
let payeurA = "";
let payeurB = "";
let debiteur = "";
let tricountId = "";

const req = (userId: string) =>
  ({ cookies: { get: () => ({ value: userId }) } }) as unknown as NextRequest;

/** Appelle la VRAIE route au nom de `userId`. */
async function valider(userId: string) {
  return POST(req(userId), { params: Promise.resolve({ id: tricountId }) });
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — l'ouverture des remboursements", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ POST } = await import("@/app/api/tricount/[id]/approve/route"));

    const [a, b, c] = await Promise.all([
      prisma.user.create({ data: { displayName: `${MARQUEUR} A` } }),
      prisma.user.create({ data: { displayName: `${MARQUEUR} B` } }),
      prisma.user.create({ data: { displayName: `${MARQUEUR} C` } }),
    ]);
    payeurA = a.id;
    payeurB = b.id;
    debiteur = c.id;

    // Deux payeurs, un débiteur : A et B ont chacun avancé 30 € pour eux et C.
    const t = await prisma.tricount.create({ data: { date: "2026-09-17" } });
    tricountId = t.id;
    for (const payeur of [payeurA, payeurB]) {
      await prisma.expense.create({
        data: {
          tricountId,
          payerId: payeur,
          creatorId: payeur,
          label: "Repas",
          amountCents: 3000,
          spentAt: new Date("2026-09-17T12:00:00"),
          shares: {
            create: [
              { userId: payeur, amountCents: 1500 },
              { userId: debiteur, amountCents: 1500 },
            ],
          },
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!tricountId) return;
    await prisma.tricount.deleteMany({ where: { id: tricountId } });
    await prisma.user.deleteMany({ where: { id: { in: [payeurA, payeurB, debiteur] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.tricountApproval.deleteMany({ where: { tricountId } });
  });

  it("deux payeurs qui valident en parallèle : exactement UNE annonce, dix fois de suite", async () => {
    // On rejoue la course plusieurs fois : sans entrelacement forcé — impossible à travers la
    // route sans la dénaturer — c'est la RÉPÉTITION qui fait rencontrer le cas où les deux
    // transactions se chevauchent. L'assertion, elle, doit tenir dans tous les cas.
    for (let tour = 1; tour <= 10; tour++) {
      vi.clearAllMocks();
      await prisma.tricountApproval.deleteMany({ where: { tricountId } });

      const [ra, rb] = await Promise.all([valider(payeurA), valider(payeurB)]);

      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      // Les deux validations sont enregistrées : en perdre une bloquerait le tricount.
      const enBase = await prisma.tricountApproval.findMany({ where: { tricountId } });
      expect(enBase, `tour ${tour}`).toHaveLength(2);
      // Et le débiteur est prévenu UNE fois : ni zéro, ni deux.
      expect(h.push.mock.calls.length, `tour ${tour}`).toBe(1);
      expect((h.push.mock.calls[0] as unknown as [string])[0]).toBe(debiteur);
    }
  }, 60_000);

  it("le second valideur annonce, le premier non", async () => {
    // Le déroulé ordinaire, séquentiel : c'est bien la validation qui COMPLÈTE le compte qui
    // déclenche l'annonce, pas la première venue.
    await valider(payeurA);
    expect(h.push).not.toHaveBeenCalled();
    await valider(payeurB);
    expect(h.push).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("une validation rejouée n'annonce rien", async () => {
    // Réponse perdue puis requête rejouée par le client : la validation est déjà en base, ce
    // clic n'ouvre donc rien. Avant, la seconde exécution relisait l'état d'avant l'écriture
    // et réannonçait l'ouverture à tous les débiteurs.
    await valider(payeurA);
    await valider(payeurB);
    expect(h.push).toHaveBeenCalledTimes(1);

    await valider(payeurB); // le rejeu
    expect(h.push).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("un non-payeur ne valide pas, et n'ouvre rien", async () => {
    const res = await valider(debiteur);
    expect(res.status).toBe(403);
    expect(await prisma.tricountApproval.findMany({ where: { tricountId } })).toHaveLength(0);
    expect(h.push).not.toHaveBeenCalled();
  }, 30_000);

  // SIX PAYEURS, PAS DEUX — le cas que le budget de rejeu ne tenait PAS.
  //
  // Le test du dessus (deux payeurs) ne produit qu'UN croisement : le perdant rejoue une fois,
  // voit la ligne du gagnant, aboutit. Quatre tentatives suffisaient presque toujours, et
  // « presque » est exactement ce que `.github/workflows/ci.yml` décrivait — un 409 environ une
  // fois sur trois sur un runner chargé.
  //
  // À six, les croisements ne s'additionnent plus, ils se multiplient : chaque validation lit
  // l'ensemble des validations, donc chacune entre en conflit avec toutes les autres encore en
  // vol. Mesuré sur vraie base, ancien réglage : 294 conflits 40001 en 60 tours, dont 4
  // épuisaient les quatre tentatives. Avec le plancher de recul, la croissance doublée et six
  // tentatives : 0 sur 60, et les conflits ne montaient jamais au-delà de la quatrième.
  //
  // CE QU'ON VÉRIFIE ICI, ce n'est pas « c'est rapide » mais « personne ne se fait renvoyer » :
  // les six validations aboutissent, les six sont en base, et UNE seule annonce part.
  it("six payeurs qui valident ensemble : personne ne reçoit « réessaie »", async () => {
    const ajoutes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        prisma.user.create({ data: { displayName: `${MARQUEUR} sup ${i}` } }),
      ),
    );
    const sup = ajoutes.map((u) => u.id);
    for (const payeur of sup) {
      await prisma.expense.create({
        data: {
          tricountId,
          payerId: payeur,
          creatorId: payeur,
          label: "Repas",
          amountCents: 3000,
          spentAt: new Date("2026-09-17T12:00:00"),
          shares: {
            create: [
              { userId: payeur, amountCents: 1500 },
              { userId: debiteur, amountCents: 1500 },
            ],
          },
        },
      });
    }
    const tous = [payeurA, payeurB, ...sup];

    try {
      // Cinq tours, et non un seul : la course ne se produit pas à tous les coups, et une seule
      // exécution laisserait le défaut repasser une fois sur deux sans faire rougir personne.
      for (let tour = 1; tour <= 5; tour++) {
        vi.clearAllMocks();
        await prisma.tricountApproval.deleteMany({ where: { tricountId } });

        const reponses = await Promise.all(tous.map(valider));

        // AUCUN 409. C'est la régression elle-même : un membre qui clique en même temps que ses
        // cinq co-payeurs ne doit pas lire « Validation concurrente, réessaie ».
        expect(reponses.map((r) => r.status), `tour ${tour}`).toEqual(tous.map(() => 200));
        const enBase = await prisma.tricountApproval.findMany({ where: { tricountId } });
        expect(enBase, `tour ${tour}`).toHaveLength(tous.length);
        expect(h.push.mock.calls.length, `tour ${tour}`).toBe(1);
        expect((h.push.mock.calls[0] as unknown as [string])[0]).toBe(debiteur);
      }
    } finally {
      // ⚠️ LES DÉPENSES D'ABORD, LES MEMBRES ENSUITE. `Expense.payerId` est en RESTRICT depuis
      // la migration `13_tricount_restrict_user_delete` — supprimer un payeur qui a encore une
      // dépense échoue, et le nettoyage laisserait le tricount à six payeurs pour les cas
      // suivants de ce fichier, qui en attendent deux.
      await prisma.expense.deleteMany({ where: { payerId: { in: sup } } });
      await prisma.tricountApproval.deleteMany({ where: { tricountId } });
      await prisma.user.deleteMany({ where: { id: { in: sup } } });
    }
  }, 180_000);
});

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("l'ouverture des remboursements n'est pas vérifiée sans base (TEST_DATABASE_URL)", () => {
    expect(SANS_BASE).toBe(true);
  });
});
