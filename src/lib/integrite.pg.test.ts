// CONTRAINTES D'INTÉGRITÉ POSÉES PAR L'AUDIT 2026-10 — SUR VRAIE BASE.
//
// Aucun bouchon ne sait ce que Postgres refuse : ces tests vérifient que les migrations 62,
// 66 et 67 disent bien ce qu'elles promettent.
//
//   * 67 : une seule délégation NON RÉVOQUÉE par couple (index unique partiel) ;
//   * 66 : une disponibilité porte un membre XOR un invité ;
//   * 62 : supprimer le créateur d'une rencontre la garde, sans créateur ;
//   * point 21 : `anonymizeMember` efface la personne et garde l'argent, sommes intactes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SANS_BASE, ouvrirBaseDeTest, codePrisma } from "./pg-harness";

type Prisma = import("@prisma/client").PrismaClient;
let prisma: Prisma;
const MARQUEUR = "PG-TEST-integrite";
let a = "";
let b = "";
const efface: string[] = [];

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — contraintes d'intégrité de l'audit", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    // La CI pose la base par `prisma db push` (schéma courant), qui ignore ce que le schéma
    // Prisma ne sait pas dire : index partiel, CHECK. On joue donc ici le SQL même des
    // migrations 66 et 67 — rejouables par construction — pour éprouver ce qu'elles posent.
    for (const m of ["66_index_cles_etrangeres", "67_delegation_active_unique"]) {
      const sql = readFileSync(join(process.cwd(), "prisma/migrations", m, "migration.sql"), "utf8");
      for (const stmt of sql.replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(stmt);
      }
    }
    await prisma.user.deleteMany({ where: { displayName: { startsWith: MARQUEUR } } });
    a = (await prisma.user.create({ data: { displayName: `${MARQUEUR} A` } })).id;
    b = (await prisma.user.create({ data: { displayName: `${MARQUEUR} B` } })).id;
  });

  afterAll(async () => {
    await prisma?.tricount.deleteMany({ where: { title: MARQUEUR } });
    await prisma?.interclubTeam.deleteMany({ where: { name: MARQUEUR } });
    await prisma?.user.deleteMany({ where: { displayName: { startsWith: MARQUEUR } } });
    await prisma?.user.deleteMany({ where: { id: { in: efface } } });
  });

  it("67 : deux délégations vivantes pour le même couple sont refusées (P2002)", async () => {
    const data = { delegatorId: a, delegateId: b, expiresAt: new Date(Date.now() + 864e5) };
    await prisma.delegation.create({ data });
    const err = await prisma.delegation.create({ data }).catch((e) => e);
    expect(codePrisma(err)).toBe("P2002");
    // Révoquée, l'ancienne libère la place.
    await prisma.delegation.updateMany({ where: { delegatorId: a }, data: { revokedAt: new Date() } });
    await expect(prisma.delegation.create({ data })).resolves.toBeTruthy();
  });

  it("62 + 66 : la rencontre survit à son créateur ; membre XOR invité sur les disponibilités", async () => {
    const team = await prisma.interclubTeam.create({ data: { name: MARQUEUR } });
    const createur = await prisma.user.create({ data: { displayName: `${MARQUEUR} C` } });
    const ic = await prisma.interclub.create({
      data: { date: "2027-01-10", teamId: team.id, opponent: "Massy", createdById: createur.id },
    });
    await prisma.user.delete({ where: { id: createur.id } });
    const relu = await prisma.interclub.findUniqueOrThrow({ where: { id: ic.id } });
    expect(relu.createdById).toBeNull();

    const sansPersonne = await prisma.interclubAvailability
      .create({ data: { interclubId: ic.id, status: "yes" } })
      .catch((e) => e);
    expect(String((sansPersonne as Error).message)).toMatch(/user_xor_guest/);
    await prisma.interclub.delete({ where: { id: ic.id } });
  });

  it("21 : anonymizeMember efface la personne, garde ses dépenses à l'identique", async () => {
    const { anonymizeMember, ANONYMIZED_NAME } = await import("./members");
    const u = await prisma.user.create({
      data: { displayName: `${MARQUEUR} RGPD`, email: "rgpd-pg@exemple.fr", nickname: "Rg" },
    });
    const tc = await prisma.tricount.create({ data: { date: "2099-12-30", title: MARQUEUR } });
    const dep = await prisma.expense.create({
      data: {
        tricountId: tc.id,
        payerId: a,
        creatorId: a,
        label: "Repas",
        amountCents: 3000,
        shares: { create: [{ userId: a, amountCents: 1500 }, { userId: u.id, amountCents: 1500 }] },
      },
    });
    await prisma.forumMessage.create({ data: { authorId: u.id, body: "un message personnel" } });
    await prisma.session.create({ data: { id: `${MARQUEUR}-sid`, userId: u.id, expiresAt: new Date(Date.now() + 864e5) } });

    efface.push(u.id);
    await prisma.$transaction((tx) => anonymizeMember(u.id, tx));

    const relu = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(relu).toMatchObject({ displayName: ANONYMIZED_NAME, email: null, nickname: null, listed: false });
    expect(relu.disabledAt).not.toBeNull();
    expect(await prisma.forumMessage.count({ where: { authorId: u.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
    const parts = await prisma.expenseShare.findMany({ where: { expenseId: dep.id } });
    expect(parts.reduce((t, p) => t + p.amountCents, 0)).toBe(3000);
    expect(parts.some((p) => p.userId === u.id)).toBe(true);
  });

  it("68 : un défi WebAuthn ne se consomme qu'une fois", async () => {
    const { consumeChallenge } = await import("./webauthn");
    const defi = { challenge: `${MARQUEUR}-${Date.now()}`, exp: Date.now() + 300_000 };
    expect(await consumeChallenge(defi)).toBe(true);
    expect(await consumeChallenge(defi)).toBe(false);
  });

  it("24 : une session ancienne (identifiant en clair) est retrouvée puis renommée sous son empreinte", async () => {
    process.env.CREDENTIALS_SECRET ||= Buffer.alloc(32, 3).toString("base64");
    const { getSession } = await import("./session");
    const { hashSessionId } = await import("./crypto");
    const sid = `${MARQUEUR}-ancienne-${Date.now()}`;
    await prisma.session.create({ data: { id: sid, userId: a, expiresAt: new Date(Date.now() + 864e5) } });
    expect((await getSession(sid))?.userId).toBe(a);
    expect(await prisma.session.findUnique({ where: { id: sid } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: hashSessionId(sid) } })).not.toBeNull();
    expect((await getSession(sid))?.userId).toBe(a);
  });
});
