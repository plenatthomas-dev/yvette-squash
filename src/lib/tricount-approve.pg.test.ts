// « LES REMBOURSEMENTS SONT OUVERTS » NE PART QU'UNE FOIS — sur une vraie base.
//
// La route `POST /api/tricount/{id}/approve` décidait cette transition sur une lecture faite
// AVANT l'écriture, hors transaction. Deux payeurs qui validaient au même instant lisaient tous
// deux « aucune validation », concluaient tous deux « pas encore prêt », et le tricount devenait
// prêt sans que PERSONNE ne soit prévenu. Le défaut est silencieux : rien n'échoue, tout le
// monde attend simplement une notification qui ne partira plus.
//
// Le correctif relit les validations APRÈS l'upsert, dans une transaction Serializable. Sa
// justesse repose entièrement sur ce que Postgres fait de deux transactions qui lisent le même
// ensemble et y insèrent chacune une ligne — un write-skew. Aucun faux client ne peut répondre
// à cette question : il rendrait ce qu'on lui a soufflé. D'où ce fichier.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SANS_BASE, codePrisma, jalon, ouvrirBaseDeTest } from "./pg-harness";

type Prisma = import("@prisma/client").PrismaClient;
type Tx = import("@prisma/client").Prisma.TransactionClient;

let prisma: Prisma;
let serializableTransaction: typeof import("./http-tx").serializableTransaction;

const MARQUEUR = "PG-TEST-tricount-approve";
let payeurA = "";
let payeurB = "";
let debiteur = "";
let tricountId = "";

/**
 * La garde de la route, reproduite : écrire ma validation, relire l'ensemble, et n'annoncer
 * que si ma validation n'existait pas ET que toutes sont là.
 */
async function valider(tx: Tx, userId: string, payeurs: string[]): Promise<boolean> {
  const dejaValide = await tx.tricountApproval.findUnique({
    where: { tricountId_userId: { tricountId, userId } },
    select: { userId: true },
  });
  await tx.tricountApproval.upsert({
    where: { tricountId_userId: { tricountId, userId } },
    update: {},
    create: { tricountId, userId },
  });
  const apres = await tx.tricountApproval.findMany({
    where: { tricountId },
    select: { userId: true },
  });
  const approuves = new Set(apres.map((a) => a.userId));
  return !dejaValide && payeurs.every((p) => approuves.has(p));
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — l'ouverture des remboursements", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ serializableTransaction } = await import("./http-tx"));

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
    await prisma.tricountApproval.deleteMany({ where: { tricountId } });
  });

  it("deux payeurs qui valident VRAIMENT en même temps : exactement UNE annonce", async () => {
    // L'entrelacement est forcé : chacun écrit sa validation, puis attend que l'autre ait
    // écrit la sienne avant de relire l'ensemble. C'est le pire cas, et le seul qui puisse
    // produire la double annonce ou l'absence d'annonce.
    const payeurs = [payeurA, payeurB];
    const ecritA = jalon();
    const ecritB = jalon();

    const lancer = (moi: string, mien: ReturnType<typeof jalon>, autre: ReturnType<typeof jalon>) =>
      serializableTransaction(async (tx) => {
        const dejaValide = await tx.tricountApproval.findUnique({
          where: { tricountId_userId: { tricountId, userId: moi } },
          select: { userId: true },
        });
        await tx.tricountApproval.upsert({
          where: { tricountId_userId: { tricountId, userId: moi } },
          update: {},
          create: { tricountId, userId: moi },
        });
        mien.ouvrir();
        await autre.atteint;
        const apres = await tx.tricountApproval.findMany({
          where: { tricountId },
          select: { userId: true },
        });
        const approuves = new Set(apres.map((a) => a.userId));
        return !dejaValide && payeurs.every((p) => approuves.has(p));
      });

    const [ra, rb] = await Promise.allSettled([
      lancer(payeurA, ecritA, ecritB),
      lancer(payeurB, ecritB, ecritA),
    ]);

    // eslint-disable-next-line no-console
    console.log(
      `[approve] A=${ra.status === "fulfilled" ? ra.value : codePrisma(ra.reason)} · ` +
        `B=${rb.status === "fulfilled" ? rb.value : codePrisma(rb.reason)}`,
    );

    // Les deux validations doivent aboutir : perdre celle d'un payeur bloquerait le tricount.
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("fulfilled");
    const annonces = [ra, rb].filter((r) => r.status === "fulfilled" && r.value === true).length;
    expect(annonces).toBe(1); // ni zéro (personne prévenu), ni deux (tout le monde, deux fois)

    const enBase = await prisma.tricountApproval.findMany({ where: { tricountId } });
    expect(enBase).toHaveLength(2);
  }, 30_000);

  it("contre-épreuve : en Read Committed, la même course ne prévient PERSONNE", async () => {
    // Le défaut d'origine, obtenu exprès. Sans cette contre-épreuve, le test précédent
    // passerait tout aussi bien sur un code sans protection, et on croirait la garde
    // suffisante à elle seule : c'est le niveau d'ISOLATION qui la rend atomique.
    const payeurs = [payeurA, payeurB];
    const ecritA = jalon();
    const ecritB = jalon();

    const lancer = (moi: string, mien: ReturnType<typeof jalon>, autre: ReturnType<typeof jalon>) =>
      prisma.$transaction(
        async (tx) => {
          const dejaValide = await tx.tricountApproval.findUnique({
            where: { tricountId_userId: { tricountId, userId: moi } },
            select: { userId: true },
          });
          await tx.tricountApproval.upsert({
            where: { tricountId_userId: { tricountId, userId: moi } },
            update: {},
            create: { tricountId, userId: moi },
          });
          mien.ouvrir();
          await autre.atteint;
          const apres = await tx.tricountApproval.findMany({
            where: { tricountId },
            select: { userId: true },
          });
          const approuves = new Set(apres.map((a) => a.userId));
          return !dejaValide && payeurs.every((p) => approuves.has(p));
        },
        { isolationLevel: "ReadCommitted", timeout: 20_000 },
      );

    const [ra, rb] = await Promise.allSettled([
      lancer(payeurA, ecritA, ecritB),
      lancer(payeurB, ecritB, ecritA),
    ]);
    const annonces = [ra, rb].filter((r) => r.status === "fulfilled" && r.value === true).length;
    // eslint-disable-next-line no-console
    console.log(`[approve/ReadCommitted] ${annonces} annonce(s)`);

    expect(annonces).toBe(0); // le tricount s'ouvre, et personne ne l'apprend
  }, 30_000);

  it("une validation rejouée n'annonce rien, même seule à manquer", async () => {
    // Le second cas que la garde couvre : réponse perdue, requête rejouée. La validation est
    // déjà en base, ce clic n'ouvre donc rien.
    const payeurs = [payeurA, payeurB];
    await serializableTransaction((tx) => valider(tx, payeurA, payeurs));
    const premiere = await serializableTransaction((tx) => valider(tx, payeurB, payeurs));
    const rejeu = await serializableTransaction((tx) => valider(tx, payeurB, payeurs));

    expect(premiere).toBe(true);
    expect(rejeu).toBe(false);
  }, 30_000);
});

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("l'ouverture des remboursements n'est pas vérifiée sans base (TEST_DATABASE_URL)", () => {
    expect(SANS_BASE).toBe(true);
  });
});
