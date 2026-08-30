import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA VUE QUE TOUT LE MONDE LIT, ET QUE RIEN NE VÉRIFIAIT.
//
// Cette route ne se contente pas de rendre des lignes : elle DÉCIDE. Elle calcule les soldes,
// propose les virements, déclare un tricount « prêt » ou « soldé », et pose sur chaque dépense
// les deux drapeaux `canDelete`/`canEdit` dont l'interface se sert pour montrer ou cacher les
// boutons. Une erreur ici ne provoque aucune exception : elle affiche simplement le mauvais
// montant, ou offre à quelqu'un un bouton qu'il n'aurait pas dû voir — et le serveur, lui,
// refusera plus tard, sans que l'écran ait prévenu.
//
// Les fonctions pures (`computeBalances`, `settle`) sont utilisées ICI TELLES QUELLES : ce
// qu'on mesure, c'est l'assemblage, la pagination et le tri, pas l'arithmétique déjà éprouvée
// dans `tricount.test.ts`.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  users: [] as { id: string; displayName: string }[],
  rows: [] as Record<string, unknown>[],
  takeDemande: 0,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => h.users) },
    tricount: {
      findMany: vi.fn(async (a: { take: number }) => {
        h.takeDemande = a.take;
        return h.rows.slice(0, a.take);
      }),
    },
  },
}));

import { GET } from "./route";

const req = (query = "") =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    nextUrl: { searchParams: new URLSearchParams(query) },
  }) as unknown as NextRequest;

const resaUser = { userId: "u1", displayName: "Alice", resa: { accessToken: "t" } };

/** Une dépense telle que Prisma la rend (payeur membre ou invité). */
function depense(o: {
  id?: string;
  payer: string;
  montant: number;
  entre: string[];
  isRefund?: boolean;
  creatorId?: string;
}) {
  const part = Math.floor(o.montant / o.entre.length);
  return {
    id: o.id ?? "e1",
    label: "Repas",
    amountCents: o.montant,
    isRefund: o.isRefund ?? false,
    spentAt: new Date("2026-09-03T12:00:00Z"),
    creatorId: o.creatorId ?? o.payer,
    payerId: o.payer.startsWith("g") ? null : o.payer,
    payerGuestId: o.payer.startsWith("g") ? o.payer : null,
    shares: o.entre.map((k) => ({
      userId: k.startsWith("g") ? null : k,
      guestId: k.startsWith("g") ? k : null,
      amountCents: part,
    })),
  };
}

function tricount(o: {
  id: string;
  date: string;
  expenses?: unknown[];
  approvals?: string[];
  guests?: { id: string; name: string }[];
  comments?: { id: string; body: string; userId: string; createdAt: Date }[];
}) {
  return {
    id: o.id,
    date: o.date,
    title: null,
    expenses: o.expenses ?? [],
    approvals: (o.approvals ?? []).map((userId) => ({ userId })),
    comments: o.comments ?? [],
    guests: o.guests ?? [],
  };
}

async function corps(query = "") {
  const res = await GET(req(query));
  return (await res.json()) as {
    me: string;
    emailOnly: boolean;
    hasMore: boolean;
    members: { id: string; name: string }[];
    tricounts: Record<string, never>[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = resaUser;
  h.tricountOn = true;
  h.users = [
    { id: "u1", displayName: "Alice" },
    { id: "u2", displayName: "Bob" },
  ];
  h.rows = [];
});

describe("GET /api/tricount — les gardes", () => {
  it("répond 404 quand la fonction est coupée, sans lire la session", async () => {
    h.tricountOn = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("annonce le compte « email seul », dont l'IHM déduit ce qu'elle masque", async () => {
    h.session = { userId: "u1", displayName: "Alice", resa: null };
    expect((await corps()).emailOnly).toBe(true);
    h.session = resaUser;
    expect((await corps()).emailOnly).toBe(false);
  });
});

describe("GET /api/tricount — la pagination", () => {
  beforeEach(() => {
    h.rows = Array.from({ length: 40 }, (_, i) =>
      tricount({ id: `t${i}`, date: `2026-08-${String(40 - i).padStart(2, "0")}` }),
    );
  });

  it("s'arrête à 25 tricounts par défaut, et le dit par `hasMore`", async () => {
    const c = await corps();
    expect(h.takeDemande).toBe(26); // limit + 1, pour savoir s'il reste quelque chose
    expect(c.tricounts).toHaveLength(25);
    expect(c.hasMore).toBe(true);
  });

  it("rend `hasMore: false` quand la fenêtre couvre tout l'historique", async () => {
    h.rows = h.rows.slice(0, 3);
    const c = await corps("limit=25");
    expect(c.tricounts).toHaveLength(3);
    expect(c.hasMore).toBe(false);
  });

  it("plafonne à 200, quoi qu'on demande", async () => {
    await corps("limit=99999");
    expect(h.takeDemande).toBe(201);
  });

  it("retombe sur 25 devant une valeur absurde, plutôt que de tout renvoyer", async () => {
    // Un `limit` invalide ne doit jamais valoir « pas de limite » : c'est le motif qui fait
    // grossir une réponse sans fin avec l'historique.
    for (const q of ["limit=abc", "limit=0", "limit=-5", "limit="]) {
      await corps(q);
      expect(h.takeDemande).toBe(26);
    }
  });

  it("tronque une limite décimale au lieu de la refuser", async () => {
    await corps("limit=3.7");
    expect(h.takeDemande).toBe(4); // floor(3.7) + 1
  });
});

describe("GET /api/tricount — l'ordre d'affichage", () => {
  it("met les tricounts SOLDÉS en bas, et les plus récents en tête à statut égal", async () => {
    // Un tricount soldé n'appelle plus aucune action : il doit céder la place à ceux qui en
    // attendent une, quelle que soit sa date.
    const solde = tricount({
      id: "solde",
      date: "2026-09-10", // le plus récent, et pourtant il doit finir dernier
      expenses: [depense({ payer: "u1", montant: 1000, entre: ["u1"] })],
      approvals: ["u1"],
    });
    const enCours = (id: string, date: string) =>
      tricount({
        id,
        date,
        expenses: [depense({ payer: "u1", montant: 1000, entre: ["u1", "u2"] })],
      });
    h.rows = [solde, enCours("vieux", "2026-08-01"), enCours("recent", "2026-09-01")];

    const c = await corps();
    expect(c.tricounts.map((t) => (t as unknown as { id: string }).id)).toEqual([
      "recent",
      "vieux",
      "solde",
    ]);
  });
});

describe("GET /api/tricount — ce que la vue décide", () => {
  it("ne déclare pas « prêt » un tricount SANS PAYEUR", async () => {
    // Le cas du tricount réduit à des remboursements (ou vide) : sans payeur, la condition
    // « tous les payeurs ont validé » serait vraie par vacuité, et les remboursements
    // s'ouvriraient sur un tricount qui n'a rien à rembourser.
    h.rows = [tricount({ id: "t1", date: "2026-09-03" })];
    const [t] = (await corps()).tricounts as unknown as { ready: boolean; settled: boolean }[];
    expect(t.ready).toBe(false);
    expect(t.settled).toBe(false);
  });

  it("pose `canDelete` sur le créateur ET sur le payeur, et sur personne d'autre", async () => {
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        expenses: [
          depense({ id: "sienne", payer: "u1", montant: 1000, entre: ["u1", "u2"] }),
          depense({ id: "autre", payer: "u2", montant: 1000, entre: ["u1", "u2"], creatorId: "u2" }),
          depense({ id: "saisie", payer: "u2", montant: 1000, entre: ["u1", "u2"], creatorId: "u1" }),
          depense({ id: "payee", payer: "u1", montant: 1000, entre: ["u1", "u2"], creatorId: "u2" }),
        ],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as {
      expenses: { id: string; canDelete: boolean; canEdit: boolean }[];
    }[];
    const par = Object.fromEntries(t.expenses.map((e) => [e.id, e]));
    expect(par.sienne.canDelete).toBe(true); // payeur ET créateur
    expect(par.saisie.canDelete).toBe(true); // créateur seulement
    // Payeur seulement : quelqu'un d'autre a saisi la ligne, mais c'est mon argent qui est
    // sorti. Sans ce cas, retirer la clause « ou payeur » ne ferait tomber aucun test — le
    // contrôle par mutation l'a dit.
    expect(par.payee.canDelete).toBe(true);
    expect(par.autre.canDelete).toBe(false); // ni l'un ni l'autre
  });

  it("n'offre JAMAIS l'édition d'un remboursement, même au sien", async () => {
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        expenses: [depense({ id: "r", payer: "u1", montant: 1000, entre: ["u2"], isRefund: true })],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as {
      expenses: { canDelete: boolean; canEdit: boolean }[];
    }[];
    expect(t.expenses[0].canDelete).toBe(true);
    expect(t.expenses[0].canEdit).toBe(false);
  });

  it("rend les soldes ET les virements du MÊME appel, tous deux justes", async () => {
    // `settle` consomme les soldes qu'on sérialise juste après : s'il les mutait, la réponse
    // afficherait des soldes déjà remis à zéro à côté des virements qu'ils justifient.
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        expenses: [depense({ payer: "u1", montant: 3000, entre: ["u1", "u2"] })],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as {
      balances: { id: string; cents: number }[];
      transfers: { fromId: string; toId: string; amountCents: number }[];
    }[];
    expect(t.balances).toEqual([
      { id: "u1", kind: "user", name: "Alice", cents: 1500 },
      { id: "u2", kind: "user", name: "Bob", cents: -1500 },
    ]);
    expect(t.transfers).toEqual([
      expect.objectContaining({ fromId: "u2", toId: "u1", amountCents: 1500 }),
    ]);
    // Somme nulle : la propriété qui dit que rien ne s'est perdu en route.
    expect(t.balances.reduce((s, b) => s + b.cents, 0)).toBe(0);
  });

  it("suffixe « (ext) » le nom d'un invité, et retombe sur « ? » pour une clé inconnue", async () => {
    // Le suffixe n'est jamais stocké : c'est cette route qui l'ajoute. Et un membre supprimé
    // laisse des parts derrière lui — mieux vaut « ? » qu'une exception.
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        guests: [{ id: "g1", name: "Marc" }],
        expenses: [depense({ payer: "u1", montant: 1000, entre: ["g1", "uDisparu"] })],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as {
      guests: { name: string }[];
      balances: { name: string }[];
    }[];
    expect(t.guests[0].name).toBe("Marc (ext)");
    expect(t.balances.map((b) => b.name).sort()).toEqual(["?", "Alice", "Marc (ext)"]);
  });

  it("laisse chacun supprimer ses seuls messages", async () => {
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        comments: [
          { id: "c1", body: "à moi", userId: "u1", createdAt: new Date("2026-09-03") },
          { id: "c2", body: "à l'autre", userId: "u2", createdAt: new Date("2026-09-03") },
        ],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as {
      comments: { id: string; canDelete: boolean; userName: string }[];
    }[];
    expect(t.comments.map((c) => [c.id, c.canDelete])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
    expect(t.comments[1].userName).toBe("Bob");
  });

  it("ne compte PAS les remboursements dans le total de la soirée", async () => {
    // Le total affiché est « ce que la soirée a coûté », pas « ce qui a circulé ».
    h.rows = [
      tricount({
        id: "t1",
        date: "2026-09-03",
        expenses: [
          depense({ id: "vraie", payer: "u1", montant: 3000, entre: ["u1", "u2"] }),
          depense({ id: "remb", payer: "u2", montant: 1500, entre: ["u1"], isRefund: true }),
        ],
      }),
    ];
    const [t] = (await corps()).tricounts as unknown as { totalCents: number }[];
    expect(t.totalCents).toBe(3000);
  });
});
