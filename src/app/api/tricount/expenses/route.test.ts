import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA ROUTE QUI ÉCRIT L'ARGENT — et qui n'avait aucun test.
//
// `tricount.test.ts` éprouve les fonctions pures : `splitEqually`, `splitWithCredits`,
// `splitByWeights` rendent bien une somme égale au montant. Mais personne ne vérifiait ce que
// la ROUTE écrit réellement en base — or c'est elle qui choisit la fonction, construit la
// mémoire des arrondis, et surtout apparie les parts calculées aux bons participants.
//
// C'est ce dernier point qui rend le trou coûteux : une interversion entre membres et invités
// donnerait la part de l'un à l'autre SANS casser la moindre somme. Tous les invariants
// arithmétiques resteraient verts, et l'erreur ne se verrait qu'en euros, chez quelqu'un.
//
// Ces tests mesurent donc le CORPS ÉCRIT (`prisma.expense.create`), pas une valeur de retour.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  /** Membres connus de la base. */
  users: ["u1", "u2", "u3"] as string[],
  /** Invités connus SUR LE TRICOUNT DE LA DATE demandée. */
  guests: ["g1", "g2"] as string[],
  /** Dépenses déjà enregistrées, qui nourrissent la mémoire des arrondis. */
  existing: [] as { amountCents: number; shares: { userId: string | null; guestId: string | null; amountCents: number }[] }[],
  /** Ce que la route a demandé d'écrire. */
  created: null as null | Record<string, unknown>,
  upsertArg: null as null | Record<string, unknown>,
  approvalsDeleted: vi.fn(),
  guestWhere: null as null | Record<string, unknown>,
  /** Le tricount de la date visée, ou `null` s'il n'existe pas encore. */
  tricountEtat: null as null | Record<string, unknown>,
  soldeWhere: null as null | Record<string, unknown>,
  /** Comptes desactives, que la route doit refuser comme PAYEUR. */
  disabled: [] as string[],
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ tricount: h.tricountOn }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (a: { where: { id: { in: string[] } } }) =>
        a.where.id.in
          .filter((id) => h.users.includes(id))
          .map((id) => ({ id, disabledAt: h.disabled.includes(id) ? new Date() : null })),
      ),
    },
    tricountGuest: {
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
        h.guestWhere = a.where;
        const ids = (a.where.id as { in: string[] }).in;
        return ids.filter((id) => h.guests.includes(id)).map((id) => ({ id }));
      }),
    },
    tricount: {
      upsert: vi.fn(async (a: Record<string, unknown>) => {
        h.upsertArg = a;
        return { id: "t1" };
      }),
      // L'état du tricount de cette DATE, tel que `refuseSiSolde` le relit avant d'écrire.
      // `null` = il n'existe pas encore (première dépense du jour), le cas courant.
      findUnique: vi.fn(async (a: { where: Record<string, unknown> }) => {
        h.soldeWhere = a.where;
        return h.tricountEtat;
      }),
    },
    expense: {
      findMany: vi.fn(async () => h.existing),
      create: vi.fn(async (a: Record<string, unknown>) => {
        h.created = a;
        return { id: "e1" };
      }),
    },
    tricountApproval: { deleteMany: h.approvalsDeleted },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { POST } from "./route";

const req = (body: unknown) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => body,
  }) as unknown as NextRequest;

const resaUser = { userId: "u1", displayName: "Membre", resa: { accessToken: "t" } };
const emailOnly = { userId: "u1", displayName: "Membre", resa: null };

/** Le corps minimal valide, que chaque test amende. */
const base = {
  date: "2026-09-03",
  label: "Repas",
  amountCents: 3000,
  payerId: "u1",
  participantIds: ["u1", "u2"],
};

/** Les parts effectivement écrites, sous la forme [clé, centimes]. */
function partsEcrites(): [string, number][] {
  const data = h.created!.data as { shares: { create: Record<string, unknown>[] } };
  return data.shares.create.map((s) => [
    (s.userId as string) ? `u:${s.userId}` : `g:${s.guestId}`,
    s.amountCents as number,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = resaUser;
  h.tricountOn = true;
  h.users = ["u1", "u2", "u3"];
  h.guests = ["g1", "g2"];
  h.existing = [];
  h.created = null;
  h.upsertArg = null;
  h.guestWhere = null;
  h.tricountEtat = null;
  h.soldeWhere = null;
  h.disabled = [];
});

describe("POST /api/tricount/expenses — les trois gardes d'entrée", () => {
  it("répond 404 quand la fonction est coupée, sans lire la session", async () => {
    h.tricountOn = false;
    const res = await POST(req(base));
    expect(res.status).toBe(404);
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    expect((await POST(req(base))).status).toBe(401);
  });

  it("répond 403 à un compte « email seul », qui ne gère pas les dépenses", async () => {
    h.session = emailOnly;
    const res = await POST(req(base));
    expect(res.status).toBe(403);
    expect(h.created).toBeNull();
  });
});

describe("POST /api/tricount/expenses — ce qui est écrit vaut ce qui a été saisi", () => {
  it("écrit des parts dont la somme vaut EXACTEMENT le montant", async () => {
    // L'invariant central de l'application. Il est prouvé sur les fonctions pures ; ici on le
    // prouve sur ce qui part en base, y compris quand le montant ne tombe pas juste.
    for (const [montant, membres] of [
      [3000, ["u1", "u2"]],
      [1000, ["u1", "u2", "u3"]], // 10,00 € entre 3 : le cas à centimes
      [1, ["u1", "u2", "u3"]], // un centime pour trois
      [999_999, ["u1", "u2", "u3"]],
    ] as [number, string[]][]) {
      h.existing = [];
      await POST(req({ ...base, amountCents: montant, participantIds: membres }));
      const parts = partsEcrites();
      expect(parts).toHaveLength(membres.length);
      expect(parts.reduce((s, [, c]) => s + c, 0)).toBe(montant);
    }
  });

  it("donne à chacun SA part : membres en `userId`, invités en `guestId`, jamais l'inverse", async () => {
    // Le défaut que rien n'aurait attrapé : une interversion garde toutes les sommes justes.
    // On demande donc des parts DISTINCTES (mode pondéré) pour que chaque centime désigne son
    // porteur sans ambiguïté.
    await POST(
      req({
        ...base,
        amountCents: 4000,
        participantIds: ["u1", "u2"],
        guestIds: ["g1"],
        weights: { u1: 1, u2: 2, g1: 5 },
      }),
    );
    expect(partsEcrites()).toEqual([
      ["u:u1", 500],
      ["u:u2", 1000],
      ["g:g1", 2500],
    ]);
  });

  it("écrit le payeur, le créateur et la date ancrée à midi", async () => {
    h.session = { ...resaUser, userId: "u3" };
    await POST(req({ ...base, payerId: "u2" }));
    const d = h.created!.data as Record<string, unknown>;
    expect(d).toMatchObject({ tricountId: "t1", payerId: "u2", creatorId: "u3", label: "Repas" });
    // Midi : une dépense saisie le soir ne doit pas glisser de jour selon le fuseau.
    expect((d.spentAt as Date).getHours()).toBe(12);
  });

  it("remet à zéro les validations, dans la MÊME transaction que la dépense", async () => {
    // Les montants changent : chaque payeur doit revalider avant que les remboursements
    // rouvrent. Hors transaction, une dépense pourrait s'ajouter en laissant les validations.
    await POST(req(base));
    expect(h.approvalsDeleted).toHaveBeenCalledWith({ where: { tricountId: "t1" } });
  });

  it("dédoublonne les participants", async () => {
    await POST(req({ ...base, amountCents: 300, participantIds: ["u1", "u2", "u1"] }));
    expect(partsEcrites().map(([k]) => k)).toEqual(["u:u1", "u:u2"]);
  });
});

describe("POST /api/tricount/expenses — qui a le droit de figurer", () => {
  it("refuse un payeur inconnu de la base", async () => {
    const res = await POST(req({ ...base, payerId: "u404" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Membre inconnu" });
  });

  it("refuse UN INVITÉ COMME PAYEUR — le schéma le déclare, la route doit l'appliquer", async () => {
    // `Expense` porte `payerId` OU `payerGuestId`, et cette route n'écrit jamais le second :
    // un id d'invité passé en `payerId` doit donc être rejeté comme membre inconnu, et non
    // écrit tel quel dans une colonne qui référence `User`.
    const res = await POST(req({ ...base, payerId: "g1", guestIds: ["g1"] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Membre inconnu" });
    expect(h.created).toBeNull();
  });

  it("refuse un participant inconnu", async () => {
    const res = await POST(req({ ...base, participantIds: ["u1", "u404"] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Membre inconnu" });
  });

  it("n'accepte un invité que s'il appartient au tricount DE CETTE DATE", async () => {
    // Un invité est attaché à un tricount ; l'accepter sur une autre date rattacherait le nom
    // de quelqu'un à une soirée où il n'était pas.
    const res = await POST(req({ ...base, guestIds: ["g404"] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invité inconnu" });
    expect(h.guestWhere).toMatchObject({ tricount: { date: "2026-09-03" } });
  });
});

describe("POST /api/tricount/expenses — la validation du corps", () => {
  const refus = async (corps: unknown, message: string) => {
    const res = await POST(req(corps));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining(message) });
    expect(h.created).toBeNull();
  };

  it("refuse une date qui n'est pas au format YYYY-MM-DD", async () => {
    await refus({ ...base, date: "03/09/2026" }, "Date invalide");
    await refus({ ...base, date: 20260903 }, "Date invalide");
  });

  it("refuse un libellé vide ou de plus de 80 caractères", async () => {
    await refus({ ...base, label: "   " }, "Libellé invalide");
    await refus({ ...base, label: "x".repeat(81) }, "Libellé invalide");
  });

  it("IGNORE un `title`, qu'aucun écran n'envoie et qu'aucun n'affiche", async () => {
    // Le champ était validé, borné et stocké — mais rien ne l'envoyait, rien ne le rendait, et
    // aucune autre route ne sait l'écrire : la colonne ne pouvait être que NULL. Valider un
    // champ mort donne à lire une fonctionnalité qui n'existe pas. La route l'ignore désormais
    // au lieu de refuser en 400 sur une longueur que personne n'atteindra.
    const res = await POST(req({ ...base, title: "t".repeat(200) }));
    expect(res.status).toBe(201);
    expect(h.upsertArg).toEqual({ where: { date: "2026-09-03" }, update: {}, create: { date: "2026-09-03" } });
  });

  it("refuse un montant nul, négatif, non entier ou au-delà de 100 000 €", async () => {
    await refus({ ...base, amountCents: 0 }, "Montant invalide");
    await refus({ ...base, amountCents: -100 }, "Montant invalide");
    await refus({ ...base, amountCents: 12.5 }, "Montant invalide");
    await refus({ ...base, amountCents: 10_000_001 }, "Montant invalide");
  });

  it("refuse une dépense sans aucun participant", async () => {
    await refus({ ...base, participantIds: [], guestIds: [] }, "Participants invalides");
  });

  it("refuse un poids MANQUANT plutôt que de répartir de travers", async () => {
    // C'est la promesse explicite du commentaire : « chaque participant doit avoir un poids
    // valide, sinon on refuse (pas de partage silencieusement faux) ». Un poids absent
    // deviendrait `NaN`, donc une part indéfinie — invisible dans une somme.
    await refus(
      { ...base, participantIds: ["u1", "u2"], weights: { u1: 2 } },
      "Parts invalides",
    );
  });

  it("refuse un poids hors [1, 99] ou non entier", async () => {
    for (const w of [0, -1, 100, 1.5]) {
      await refus({ ...base, weights: { u1: w, u2: 1 } }, "Parts invalides");
    }
  });

  it("refuse un corps illisible comme un corps vide, en 400 et non en 500", async () => {
    const res = await POST({
      cookies: { get: () => ({ value: "sid" }) },
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tricount/expenses — la mémoire des arrondis", () => {
  it("compense d'une dépense à l'autre : 200 € puis 100 € entre 3 font bien 100 € chacun", async () => {
    // La promesse de `splitWithCredits`, éprouvée ici à travers la route — c'est elle qui
    // construit la mémoire à partir des dépenses déjà en base.
    h.existing = [
      {
        amountCents: 20000,
        shares: [
          { userId: "u1", guestId: null, amountCents: 6667 },
          { userId: "u2", guestId: null, amountCents: 6667 },
          { userId: "u3", guestId: null, amountCents: 6666 },
        ],
      },
    ];
    await POST(req({ ...base, amountCents: 10000, participantIds: ["u1", "u2", "u3"] }));
    const parts = Object.fromEntries(partsEcrites());
    expect(parts["u:u3"]).toBe(3334); // celui qui avait sous-payé reçoit le centime
    expect(parts["u:u1"] + parts["u:u2"] + parts["u:u3"]).toBe(10000);
  });

  it("ne se laisse PAS fausser par une dépense « par parts » déjà enregistrée", async () => {
    // Le crédit se calculait comme `amountCents / shares.length`, c'est-à-dire en supposant
    // TOUTE dépense passée répartie à parts égales. Pour une dépense pondérée, cet écart n'est
    // plus une erreur d'arrondi (moins d'un centime) mais l'écart de PONDÉRATION, qui se
    // chiffre en euros et domine ensuite le tri.
    //
    // Ici : 40 € en [2,1,1], réparti exactement. Le code en déduisait un crédit de +6,67 €
    // pour u1 et −3,33 € pour u2 et u3 — donc le centime de la dépense suivante partait chez
    // celui qui avait le plus PETIT poids, au lieu d'aller à celui qui avait le moins
    // surpayé. Une dépense pondérée n'a aucune erreur d'arrondi à léguer : elle est ignorée,
    // la mémoire reste vide, et le centime va au premier par ordre de clé.
    h.existing = [
      {
        amountCents: 4000,
        shares: [
          { userId: "u1", guestId: null, amountCents: 2000 },
          { userId: "u2", guestId: null, amountCents: 1000 },
          { userId: "u3", guestId: null, amountCents: 1000 },
        ],
      },
    ];
    await POST(req({ ...base, amountCents: 1000, participantIds: ["u1", "u2", "u3"] }));
    const parts = Object.fromEntries(partsEcrites());
    expect(parts).toEqual({ "u:u1": 334, "u:u2": 333, "u:u3": 333 });
    // La conservation, elle, tenait déjà dans les deux cas :
    expect(parts["u:u1"] + parts["u:u2"] + parts["u:u3"]).toBe(1000);
  });

  it("ignore les remboursements dans la mémoire des arrondis", async () => {
    // Un remboursement n'est pas une dépense partagée : le compter fausserait le crédit.
    await POST(req(base));
    const { prisma } = (await import("@/lib/db")) as unknown as {
      prisma: { expense: { findMany: ReturnType<typeof vi.fn> } };
    };
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tricountId: "t1", isRefund: false } }),
    );
  });
});

describe("POST /api/tricount/expenses — ce que la route refuse en amont", () => {
  it("refuse d'ajouter une dépense à un tricount SOLDÉ, en 409", async () => {
    // Sans ce contrôle, la règle appliquée à l'édition et à la suppression se contournait en
    // trois clics : ajouter une dépense remet toutes les validations à zéro, donc rouvre le
    // tricount clos. Le mock rend de vraies lignes — c'est `isSettled` qui tranche.
    h.tricountEtat = {
      expenses: [
        {
          payerId: "u1",
          payerGuestId: null,
          isRefund: false,
          shares: [
            { userId: "u1", guestId: null, amountCents: 500 },
            { userId: "u2", guestId: null, amountCents: 500 },
          ],
        },
        { payerId: "u2", payerGuestId: null, isRefund: true, shares: [{ userId: "u1", guestId: null, amountCents: 500 }] },
      ],
      approvals: [{ userId: "u1" }],
    };
    const res = await POST(req(base));
    expect(res.status).toBe(409);
    expect(h.soldeWhere).toEqual({ date: "2026-09-03" });
    expect(h.created).toBeNull();
  });

  it("refuse un PAYEUR DÉSACTIVÉ — il ne pourra jamais valider", async () => {
    // `isReady` exige la validation de tous les payeurs, et un compte désactivé n'a plus de
    // session : le tricount serait bloqué à vie. La règle n'existait que dans le sélecteur.
    h.disabled = ["u2"];
    const res = await POST(req({ ...base, payerId: "u2" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("désactivé") });
    expect(h.created).toBeNull();
  });

  it("accepte un PARTICIPANT désactivé — porter une part n'engage aucune action", async () => {
    // L'inverse enfermerait : une dépense ancienne deviendrait incorrigible dès qu'un joueur
    // quitte le club, et son nom doit de toute façon rester sur l'historique.
    h.disabled = ["u2"];
    const res = await POST(req({ ...base, payerId: "u1", participantIds: ["u1", "u2"] }));
    expect(res.status).toBe(201);
    expect(partsEcrites().map(([k]) => k)).toEqual(["u:u1", "u:u2"]);
  });
});
