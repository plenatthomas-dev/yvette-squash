import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un compte « email seul » a le droit de DÉCLARER un remboursement (route refunds) — il doit
// donc pouvoir le défaire, d'autant que PATCH lui dit « supprime-le et refais-le ». Seules les
// vraies dépenses lui restent interdites.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  expense: null as null | Record<string, unknown>,
  del: vi.fn(),
  approvalsDeleteMany: vi.fn(),
  /** Ce qu'il reste en base après la suppression : vraies dépenses / remboursements. */
  resteVraies: 1,
  resteRemboursements: 0,
  countWhere: null as null | Record<string, unknown>,
  count: vi.fn(),
  tricountDelete: vi.fn(),
  // Pour PATCH : membres et invités connus, autres dépenses du tricount, et ce qui est écrit.
  users: ["u1", "u2", "u3"] as string[],
  guests: ["g1"] as string[],
  /** Le tricount auquel appartient l'invité connu. */
  guestOwner: "t1",
  others: [] as { amountCents: number; shares: { userId: string | null; guestId: string | null; amountCents: number }[] }[],
  othersWhere: null as null | Record<string, unknown>,
  sharesDeleted: vi.fn(),
  updated: null as null | Record<string, unknown>,
  tricountEtat: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: true,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    // L'état du tricount porteur, tel que `refuseSiSolde` le relit. On rend de VRAIES
    // dépenses et de VRAIES validations : c'est `isSettled` — la vraie fonction — qui décide
    // s'il est soldé, pas le mock.
    tricount: { findUnique: vi.fn(async () => h.tricountEtat) },
    expense: {
      findUnique: vi.fn(async () => h.expense),
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
        h.othersWhere = a.where;
        return h.others;
      }),
      update: vi.fn(async (a: Record<string, unknown>) => {
        h.updated = a;
        return { id: "e1" };
      }),
    },
    expenseShare: { deleteMany: h.sharesDeleted },
    user: {
      findMany: vi.fn(async (a: { where: { id: { in: string[] } } }) =>
        a.where.id.in.filter((id) => h.users.includes(id)).map((id) => ({ id })),
      ),
    },
    tricountGuest: {
      // Le mock HONORE la clause `tricountId` : sans cela, retirer ce filtre de la route ne
      // ferait tomber aucun test — un invité d'une autre soirée passerait, et le mock aurait
      // dit oui à sa place. (Constaté par le contrôle par mutation.)
      findMany: vi.fn(async (a: { where: { id: { in: string[] }; tricountId?: string } }) => {
        if (a.where.tricountId !== undefined && a.where.tricountId !== h.guestOwner) return [];
        return a.where.id.in.filter((id) => h.guests.includes(id)).map((id) => ({ id }));
      }),
    },
    tricountApproval: { deleteMany: h.approvalsDeleteMany },
    // Les deux routes passent désormais un CALLBACK (PATCH est devenu sérialisable comme
    // DELETE) ; le mock accepte encore la forme tableau, au cas où. Le client de transaction
    // porte tout ce que les deux corps touchent.
    $transaction: async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => Promise<unknown>)({
            expense: {
              delete: h.del,
              count: h.count,
              update: vi.fn(async (a: Record<string, unknown>) => {
                h.updated = a;
                return { id: "e1" };
              }),
            },
            expenseShare: { deleteMany: h.sharesDeleted },
            tricountApproval: { deleteMany: h.approvalsDeleteMany },
            tricount: { delete: h.tricountDelete },
          }),
  },
}));

import { DELETE, PATCH } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "e1" }) };
/** Session « email seul » = aucun jeton ResaMania (resa null). */
const emailOnly = { userId: "u1", displayName: "Membre", resa: null };
const resaUser = { userId: "u1", displayName: "Membre", resa: { accessToken: "t" } };

/** Une part portée par un membre. */
const part = (userId: string, amountCents: number) => ({ userId, guestId: null, amountCents });

/** Alice a avancé 10 € pour elle et Bob : Bob doit 5 €. Rien n'est validé → non soldé. */
const EN_COURS = {
  expenses: [
    { payerId: "u1", payerGuestId: null, isRefund: false, shares: [part("u1", 500), part("u2", 500)] },
  ],
  approvals: [] as { userId: string }[],
};

/** Le même, validé par son unique payeur ET remboursé : plus rien n'est dû → soldé. */
const SOLDE = {
  expenses: [
    ...EN_COURS.expenses,
    { payerId: "u2", payerGuestId: null, isRefund: true, shares: [part("u1", 500)] },
  ],
  approvals: [{ userId: "u1" }],
};

/** Requête avec corps JSON, pour PATCH. */
const reqBody = (body: unknown) =>
  ({ cookies: { get: () => ({ value: "sid" }) }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  // Le compte HONORE la clause : c'est tout l'objet du correctif « dette inversée ». Un mock
  // qui rendrait le même chiffre avec ou sans `isRefund: false` répondrait à la place de la
  // route, et le retrait du filtre ne se verrait pas.
  h.count.mockImplementation(async (a: { where: Record<string, unknown> }) => {
    h.countWhere = a.where;
    return a.where.isRefund === false
      ? h.resteVraies
      : h.resteVraies + h.resteRemboursements;
  });
  h.resteVraies = 1;
  h.resteRemboursements = 0;
  h.countWhere = null;
  h.tricountEtat = EN_COURS;
  h.session = emailOnly;
  h.expense = { tricountId: "t1", isRefund: true, creatorId: "u1", payerId: "u1" };
  h.users = ["u1", "u2", "u3"];
  h.guests = ["g1"];
  h.guestOwner = "t1";
  h.others = [];
  h.othersWhere = null;
  h.updated = null;
});

describe("DELETE /api/tricount/expenses/[id] — compte « email seul »", () => {
  it("peut supprimer SON remboursement (le bug signalé)", async () => {
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledTimes(1);
  });

  it("ne peut toujours PAS supprimer une vraie dépense", async () => {
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(403);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("ne peut pas supprimer le remboursement d'un AUTRE (404, pas 403)", async () => {
    h.expense = { tricountId: "t1", isRefund: true, creatorId: "u2", payerId: "u2" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tricount/expenses/[id] — compte ResaMania", () => {
  it("supprime une vraie dépense et remet à zéro les validations", async () => {
    h.session = resaUser;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.approvalsDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("supprimer un remboursement ne remet PAS les validations à zéro", async () => {
    h.session = resaUser;
    await DELETE(req(), ctx);
    expect(h.approvalsDeleteMany).not.toHaveBeenCalled();
  });
});

describe("DELETE — la coquille vide, et la dette inversée qu'elle produisait", () => {
  beforeEach(() => {
    h.session = resaUser;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
  });

  it("EMPORTE le tricount quand il ne reste plus que des remboursements", async () => {
    // Le défaut : le compte portait sur TOUTES les lignes, remboursements inclus. Supprimer
    // la dernière vraie dépense laissait donc vivre un tricount qui n'en portait plus que des
    // remboursements — et un tel tricount est un piège sans issue. Plus aucun payeur, donc
    // `ready` faux à jamais : `approve` répond 403 et `refunds` 409. Pire, les soldes
    // S'INVERSENT (le seul mouvement restant est un remboursement) : celui qui avait été
    // remboursé voyait « tu dois 15,00 € » pour de l'argent qu'il avait déjà reçu.
    h.resteVraies = 0;
    h.resteRemboursements = 1;

    const res = await DELETE(req(), ctx);

    expect(res.status).toBe(200);
    expect(h.countWhere).toEqual({ tricountId: "t1", isRefund: false });
    expect(h.tricountDelete).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("garde le tricount tant qu'il reste une VRAIE dépense", async () => {
    h.resteVraies = 1;
    h.resteRemboursements = 3;
    await DELETE(req(), ctx);
    expect(h.tricountDelete).not.toHaveBeenCalled();
  });

  it("supprime le tricount quand sa dernière ligne, tous types confondus, s'en va", async () => {
    h.resteVraies = 0;
    h.resteRemboursements = 0;
    await DELETE(req(), ctx);
    expect(h.tricountDelete).toHaveBeenCalledTimes(1);
    // ⚠️ Les deux compteurs valant zéro, ce cas passerait AVEC ou SANS le filtre `isRefund` —
    // il ne distingue rien à lui seul. On vérifie donc que la question posée à la base est
    // bien la bonne : c'est le test frère qui mesure la différence de comportement.
    expect(h.countWhere).toEqual({ tricountId: "t1", isRefund: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — la modification d'une dépense, qui n'avait aucun test.
//
// C'est la seule route qui RÉÉCRIT des parts déjà attribuées. Elle porte donc deux règles
// qu'aucune autre ne porte : le remplacement doit être INTÉGRAL (un participant retiré ne doit
// pas garder sa part de la version précédente), et la mémoire des arrondis doit s'appuyer sur
// les AUTRES dépenses — se compenser avec son ancienne valeur reviendrait à corriger une erreur
// avec elle-même.
// ─────────────────────────────────────────────────────────────────────────────

/** Les parts que le PATCH a demandé d'écrire, sous la forme [clé, centimes]. */
function partsPatchees(): [string, number][] {
  const data = h.updated!.data as { shares: { create: Record<string, unknown>[] } };
  return data.shares.create.map((s) => [
    (s.userId as string) ? `u:${s.userId}` : `g:${s.guestId}`,
    s.amountCents as number,
  ]);
}

const corps = {
  label: "Repas corrigé",
  amountCents: 3000,
  payerId: "u1",
  participantIds: ["u1", "u2"],
};

describe("PATCH /api/tricount/expenses/[id] — qui a le droit", () => {
  beforeEach(() => {
    h.session = resaUser;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
  });

  it("répond 404 — et non 403 — à un tiers qui n'est ni créateur ni payeur", async () => {
    // 404 plutôt que 403 : un tiers n'a pas à apprendre qu'une dépense existe à cet id.
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u2", payerId: "u3" };
    const res = await PATCH(reqBody(corps), ctx);
    expect(res.status).toBe(404);
    expect(h.updated).toBeNull();
  });

  it("autorise le PAYEUR même s'il n'a pas saisi la ligne", async () => {
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u2", payerId: "u1" };
    expect((await PATCH(reqBody(corps), ctx)).status).toBe(200);
  });

  it("refuse en 400 la modification d'un REMBOURSEMENT, avec la marche à suivre", async () => {
    h.expense = { tricountId: "t1", isRefund: true, creatorId: "u1", payerId: "u1" };
    const res = await PATCH(reqBody(corps), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("supprime-le et refais-le"),
    });
  });

  it("refuse un compte « email seul », comme la création et la suppression", async () => {
    h.session = emailOnly;
    const res = await PATCH(reqBody(corps), ctx);
    expect(res.status).toBe(403);
    expect(h.updated).toBeNull();
  });
});

describe("PATCH /api/tricount/expenses/[id] — ce qui est réécrit", () => {
  beforeEach(() => {
    h.session = resaUser;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
  });

  it("REMPLACE les parts au lieu de les compléter", async () => {
    // Sans la suppression préalable, un participant retiré garderait sa part : le total des
    // parts dépasserait le montant, et l'invariant de conservation tomberait en silence.
    await PATCH(reqBody(corps), ctx);
    expect(h.sharesDeleted).toHaveBeenCalledWith({ where: { expenseId: "e1" } });
    const parts = partsPatchees();
    expect(parts.reduce((s, [, c]) => s + c, 0)).toBe(3000);
  });

  it("recalcule des parts dont la somme vaut exactement le nouveau montant", async () => {
    await PATCH(reqBody({ ...corps, amountCents: 1000, participantIds: ["u1", "u2", "u3"] }), ctx);
    const parts = partsPatchees();
    expect(parts.reduce((s, [, c]) => s + c, 0)).toBe(1000);
    expect(parts).toHaveLength(3);
  });

  it("EXCLUT la ligne éditée de la mémoire des arrondis", async () => {
    // Le commentaire l'affirme : se compenser avec sa propre valeur d'avant reviendrait à
    // corriger une erreur d'arrondi avec elle-même, donc à la figer.
    await PATCH(reqBody(corps), ctx);
    expect(h.othersWhere).toEqual({ tricountId: "t1", isRefund: false, id: { not: "e1" } });
  });

  it("remet à zéro les validations du tricount", async () => {
    await PATCH(reqBody(corps), ctx);
    expect(h.approvalsDeleteMany).toHaveBeenCalledWith({ where: { tricountId: "t1" } });
  });

  it("garde les invités dans `guestId` et les membres dans `userId`", async () => {
    await PATCH(
      reqBody({ ...corps, amountCents: 3000, participantIds: ["u1"], guestIds: ["g1"], weights: { u1: 1, g1: 2 } }),
      ctx,
    );
    expect(partsPatchees()).toEqual([
      ["u:u1", 1000],
      ["g:g1", 2000],
    ]);
  });

  it("refuse un invité inconnu", async () => {
    const res = await PATCH(reqBody({ ...corps, guestIds: ["g404"] }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invité inconnu" });
  });

  it("refuse un invité qui existe, mais sur UN AUTRE tricount", async () => {
    // Un invité est attaché à une soirée ; l'accepter ailleurs rattacherait le nom de
    // quelqu'un à une rencontre où il n'était pas. Le mock honore la clause `tricountId`
    // exprès : sans cela, retirer ce filtre de la route ne ferait tomber aucun test.
    h.guestOwner = "AUTRE_TRICOUNT";
    const res = await PATCH(reqBody({ ...corps, guestIds: ["g1"] }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invité inconnu" });
    expect(h.updated).toBeNull();
  });

  it("refuse un montant ou un libellé invalide, sans rien écrire", async () => {
    for (const mauvais of [
      { ...corps, amountCents: 0 },
      { ...corps, amountCents: 1.5 },
      { ...corps, label: "" },
      { ...corps, participantIds: [], guestIds: [] },
      { ...corps, payerId: "u404" },
    ]) {
      const res = await PATCH(reqBody(mauvais), ctx);
      expect(res.status).toBe(400);
      expect(h.updated).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UN TRICOUNT SOLDÉ NE SE RÉÉCRIT PLUS — côté SERVEUR, désormais.
//
// La règle n'existait que dans l'écran, qui masque « Modifier » et « Suppr. ». Un appel direct
// recalculait donc les parts, effaçait les validations et rouvrait un tricount clos — un état
// que l'interface présentait comme impossible. Une règle que seul le client applique n'est pas
// une règle.
// ─────────────────────────────────────────────────────────────────────────────

describe("Un tricount soldé", () => {
  beforeEach(() => {
    h.session = resaUser;
    h.tricountEtat = SOLDE;
  });

  it("refuse le PATCH d'une vraie dépense, en 409 et sans rien écrire", async () => {
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await PATCH(reqBody(corps), ctx);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("soldé"),
    });
    expect(h.updated).toBeNull();
    expect(h.approvalsDeleteMany).not.toHaveBeenCalled();
  });

  it("refuse la SUPPRESSION d'une vraie dépense", async () => {
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(409);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("LAISSE défaire un remboursement — c'est le seul recours contre une saisie erronée", async () => {
    // Un remboursement mal saisi est précisément ce qui peut faire croire un tricount soldé
    // alors que l'argent n'a pas bougé. Interdire de le défaire enfermerait le membre dans
    // son erreur, sans autre recours qu'un admin. La règle protège l'historique ; elle ne
    // doit pas verrouiller sa correction.
    h.expense = { tricountId: "t1", isRefund: true, creatorId: "u1", payerId: "u1" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledTimes(1);
  });

  it("laisse écrire tant qu'il RESTE quelque chose à rembourser", async () => {
    h.tricountEtat = EN_COURS;
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    expect((await PATCH(reqBody(corps), ctx)).status).toBe(200);
  });

  it("laisse écrire quand les payeurs n'ont pas tous validé, même si plus rien n'est dû", async () => {
    // « Soldé » exige les DEUX : remboursements ouverts ET aucun virement restant. Un tricount
    // équilibré mais non validé est encore en cours de constitution.
    h.tricountEtat = { ...SOLDE, approvals: [] };
    h.expense = { tricountId: "t1", isRefund: false, creatorId: "u1", payerId: "u1" };
    expect((await PATCH(reqBody(corps), ctx)).status).toBe(200);
  });
});
