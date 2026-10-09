// LES JOUEURS DU CLUB SANS COMPTE, DANS LE PARTAGE DE FRAIS — SUR VRAIE BASE.
//
// Les tests unitaires des routes simulent `lierJoueurs` : ils tiennent ce que la route fait du
// rattachement, pas le rattachement lui-même. Or c'est lui qui porte les garanties qui comptent
// en euros, et toutes reposent sur des contraintes que seul Postgres applique :
//
//   * un joueur n'est porté qu'UNE fois par tricount (`(tricountId, interclubGuestId)`), sans
//     quoi deux dépenses de la même soirée lui ouvriraient deux soldes ;
//   * un invité « (ext) » du même nom est ADOPTÉ, pas doublé — `(tricountId, name)` l'interdirait
//     de toute façon, et c'est ainsi qu'on saisissait ces joueurs avant ;
//   * la fusion admin fait passer parts et remboursements sur le membre sans changer la somme
//     d'aucune dépense, y compris quand il y figurait déjà sous son compte ;
//   * retirer un joueur de l'équipe ne retire RIEN à l'historique d'argent (SetNull).
//
// ⚠️ CE FICHIER IMPORTE LES ROUTES, il ne les recopie pas.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import type { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async (sid: string) => ({ userId: sid, displayName: sid, resa: {} })),
}));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ tricount: true, interclub: true }),
}));

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;
let POST: typeof import("@/app/api/tricount/expenses/route").POST;
let PATCH: typeof import("@/app/api/tricount/expenses/[id]/route").PATCH;
let transfererAuMembre: typeof import("./tricount-club").transfererAuMembre;

const MARQUEUR = "PG-TEST-tricount-club";
// Des dates qu'aucun autre fichier n'emploie : `Tricount.date` est unique.
const J1 = "2099-03-01";
const J2 = "2099-03-02";
const J3 = "2099-03-03";
const J4 = "2099-03-04";
const J5 = "2099-03-05";
const DATES = [J1, J2, J3, J4, J5];
let alice = "";
let membre = "";
let equipe = "";
let joueur = "";

const req = (userId: string, body: unknown) =>
  ({ cookies: { get: () => ({ value: userId }) }, json: async () => body }) as unknown as NextRequest;

/** Une dépense d'Alice, via la vraie route. */
async function depense(date: string, amountCents: number, corps: Record<string, unknown>) {
  const res = await POST(req(alice, { date, label: "Repas", amountCents, payerId: alice, ...corps }));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json()) as { id: string; tricountId: string };
}

/** Pour chaque dépense du tricount : la somme de ses parts doit valoir son montant. */
async function sommesJustes(tricountId: string) {
  const lignes = await prisma.expense.findMany({
    where: { tricountId },
    select: { amountCents: true, shares: { select: { amountCents: true } } },
  });
  for (const e of lignes) {
    expect(e.shares.reduce((s, p) => s + p.amountCents, 0)).toBe(e.amountCents);
  }
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — les joueurs du club sans compte", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ POST } = await import("@/app/api/tricount/expenses/route"));
    ({ PATCH } = await import("@/app/api/tricount/expenses/[id]/route"));
    ({ transfererAuMembre } = await import("./tricount-club"));

    await prisma.tricount.deleteMany({ where: { date: { in: DATES } } });
    const [a, m] = await Promise.all([
      prisma.user.create({ data: { displayName: `${MARQUEUR} Alice` } }),
      prisma.user.create({ data: { displayName: `${MARQUEUR} Damien` } }),
    ]);
    alice = a.id;
    membre = m.id;
    const t = await prisma.interclubTeam.create({ data: { name: `${MARQUEUR} équipe` } });
    equipe = t.id;
    joueur = (
      await prisma.interclubGuest.create({ data: { teamId: equipe, name: `${MARQUEUR} Damien` } })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.tricount.deleteMany({ where: { date: { in: DATES } } });
    await prisma.interclubTeam.deleteMany({ where: { name: { startsWith: MARQUEUR } } });
    await prisma.user.deleteMany({ where: { displayName: { startsWith: MARQUEUR } } });
    await prisma.$disconnect();
  });

  it("le porte par UN invité par tricount, à son vrai nom, d'une dépense à l'autre", async () => {
    const d1 = await depense(J1, 3000, { participantIds: [alice], clubGuestIds: [joueur] });
    await depense(J1, 1000, { participantIds: [alice], clubGuestIds: [joueur] });

    const invites = await prisma.tricountGuest.findMany({ where: { tricountId: d1.tricountId } });
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ name: `${MARQUEUR} Damien`, interclubGuestId: joueur });
    const parts = await prisma.expenseShare.findMany({ where: { guestId: invites[0].id } });
    expect(parts.map((p) => p.amountCents).sort()).toEqual([1500, 500].sort());
    await sommesJustes(d1.tricountId);
  }, 30_000);

  it("ADOPTE l'invité « (ext) » du même nom déjà saisi ce soir-là, au lieu de le doubler", async () => {
    const tc = await prisma.tricount.create({ data: { date: J2 } });
    const ext = await prisma.tricountGuest.create({
      data: { tricountId: tc.id, name: `${MARQUEUR} Damien` },
    });
    await depense(J2, 2000, { participantIds: [alice], clubGuestIds: [joueur] });

    const invites = await prisma.tricountGuest.findMany({ where: { tricountId: tc.id } });
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ id: ext.id, interclubGuestId: joueur });
  }, 30_000);

  it("deux enregistrements SIMULTANÉS ne lui créent pas deux invités", async () => {
    // Le tricount du jour existe déjà : ce qu'on met en course, c'est le RATTACHEMENT. (Deux
    // toutes premières dépenses d'un même jour, au même instant, se disputent la création du
    // tricount lui-même — une course antérieure à ce fichier, et qui n'est pas la sienne.)
    await prisma.tricount.create({ data: { date: J3 } });
    const [a, b] = await Promise.all([
      POST(req(alice, { date: J3, label: "A", amountCents: 1000, payerId: alice, participantIds: [alice], clubGuestIds: [joueur] })),
      POST(req(alice, { date: J3, label: "B", amountCents: 1000, payerId: alice, participantIds: [alice], clubGuestIds: [joueur] })),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const tc = await prisma.tricount.findUniqueOrThrow({ where: { date: J3 } });
    expect(await prisma.tricountGuest.count({ where: { tricountId: tc.id } })).toBe(1);
  }, 30_000);

  it("« Conserver la répartition » reconnaît son invité à l'édition", async () => {
    const d = await depense(J4, 3000, {
      participantIds: [alice],
      clubGuestIds: [joueur],
      weights: { [alice]: 1, [joueur]: 2 },
    });
    const res = await PATCH(
      req(alice, {
        label: "Dîner",
        amountCents: 3000,
        payerId: alice,
        participantIds: [alice],
        clubGuestIds: [joueur],
        preserveSplit: true,
      }),
      { params: Promise.resolve({ id: d.id }) },
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const parts = await prisma.expenseShare.findMany({
      where: { expenseId: d.id },
      select: { userId: true, guestId: true, amountCents: true },
    });
    expect(parts.find((p) => p.userId === alice)?.amountCents).toBe(1000);
    expect(parts.find((p) => p.guestId)?.amountCents).toBe(2000);
  }, 30_000);

  it("retirer le joueur de l'équipe ne retire RIEN à l'historique d'argent", async () => {
    const parti = await prisma.interclubGuest.create({
      data: { teamId: equipe, name: `${MARQUEUR} Parti` },
    });
    const d = await depense(J5, 2000, { participantIds: [alice], clubGuestIds: [parti.id] });
    const avant = await prisma.expenseShare.count({ where: { expense: { tricountId: d.tricountId } } });
    await prisma.interclubGuest.delete({ where: { id: parti.id } });

    const invite = await prisma.tricountGuest.findFirstOrThrow({ where: { tricountId: d.tricountId } });
    expect(invite.interclubGuestId).toBeNull(); // il redevient un invité ordinaire
    expect(await prisma.expenseShare.count({ where: { expense: { tricountId: d.tricountId } } })).toBe(avant);
    await sommesJustes(d.tricountId);
  }, 30_000);

  it("la FUSION fait passer parts et remboursements sur le membre, sans changer une seule somme", async () => {
    const tc = await prisma.tricount.findUniqueOrThrow({ where: { date: J1 } });
    const invite = await prisma.tricountGuest.findFirstOrThrow({ where: { tricountId: tc.id } });
    // Une dépense où le membre figurait DÉJÀ sous son compte : sa part doit absorber celle de
    // l'invité, pas s'y ajouter en double ligne (`(expenseId, userId)` est unique).
    const commune = await depense(J1, 3000, {
      participantIds: [alice, membre],
      clubGuestIds: [joueur],
    });
    // Et un remboursement de l'invité, confirmé par Alice.
    await prisma.expense.create({
      data: {
        tricountId: tc.id,
        payerGuestId: invite.id,
        creatorId: alice,
        label: "Remboursement",
        amountCents: 700,
        isRefund: true,
        shares: { create: [{ userId: alice, amountCents: 700 }] },
      },
    });

    // TOUTES ses soirées passent, pas seulement celle-ci : une dette oubliée sur un autre jour
    // resterait accrochée à un invité que plus rien ne relie à personne.
    const attendu =
      (await prisma.expenseShare.count({ where: { guest: { interclubGuestId: joueur } } })) +
      (await prisma.expense.count({ where: { payerGuest: { interclubGuestId: joueur } } }));
    expect(attendu).toBeGreaterThan(4); // J1 (trois parts, un remboursement), plus J2 à J4
    const deplaces = await prisma.$transaction((tx) => transfererAuMembre(tx, joueur, membre));
    expect(deplaces).toBe(attendu);

    expect(await prisma.tricountGuest.count({ where: { interclubGuestId: joueur } })).toBe(0);
    expect(await prisma.expenseShare.count({ where: { guestId: invite.id } })).toBe(0);
    const partCommune = await prisma.expenseShare.findMany({
      where: { expenseId: commune.id, userId: membre },
    });
    expect(partCommune).toHaveLength(1);
    expect(partCommune[0].amountCents).toBe(2000);
    expect(
      await prisma.expense.count({ where: { tricountId: tc.id, isRefund: true, payerId: membre } }),
    ).toBe(1);
    for (const date of [J1, J2, J3, J4]) {
      await sommesJustes((await prisma.tricount.findUniqueOrThrow({ where: { date } })).id);
    }
  }, 30_000);
});

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("le rattachement des joueurs sans compte n'est pas vérifié sans base", () => {
    expect(SANS_BASE).toBe(true);
  });
});
