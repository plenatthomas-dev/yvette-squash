import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un invité hors asso n'a ni compte ni connexion : cette route le crée (ou le
// retrouve, idempotent) sur le tricount du jour choisi. Même garde que l'ajout
// d'une dépense : réservé aux comptes ResaMania (email seul = lecture/validation
// uniquement).

const h = vi.hoisted(() => ({
  /** Drapeau de fonction : le 404 « coupée » est le premier cas canonique. */
  tricountOn: true,
  /**
   * Le journal des gestes (`LoginAttempt`, cf. lib/geste-debit.ts), en mémoire. Il HONORE
   * `ip`, `identifier` et les bornes de `createdAt` : la limite par membre s'y mesure.
   */
  journal: [] as { ip: string; identifier: string; createdAt: Date }[],
  /** Le `where` de la purge des tricounts vides. */
  purgeWhere: null as null | Record<string, unknown>,
  session: { userId: "u1", displayName: "Membre", resa: {} as unknown } as {
    userId: string;
    displayName: string;
    resa: unknown;
  } | null,
  tricountUpsert: vi.fn(async (_args: { where: unknown; update: unknown; create: unknown }) => ({
    id: "t1",
    date: "2026-07-10",
  })),
  guestUpsert: vi.fn(async (_args: { where: unknown; update: unknown; create: unknown }) => ({
    id: "g1",
    name: "Marc",
  })),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: h.tricountOn,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
  }),
}));
type WhereJournal = { ip?: string; identifier?: string; createdAt?: { gte?: Date; lt?: Date } };
const dansJournal = (
  l: { ip: string; identifier: string; createdAt: Date },
  w: WhereJournal,
) =>
  (w.ip === undefined || l.ip === w.ip) &&
  (w.identifier === undefined || l.identifier === w.identifier) &&
  (!w.createdAt?.gte || l.createdAt >= w.createdAt.gte) &&
  (!w.createdAt?.lt || l.createdAt < w.createdAt.lt);

vi.mock("@/lib/db", () => ({
  prisma: {
    tricount: {
      upsert: h.tricountUpsert,
      deleteMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
        h.purgeWhere = a.where;
        return { count: 0 };
      }),
    },
    tricountGuest: { upsert: h.guestUpsert },
    loginAttempt: {
      create: vi.fn(async ({ data }: { data: { ip: string; identifier: string } }) => {
        h.journal.push({ ...data, createdAt: new Date() });
        return {};
      }),
      count: vi.fn(async ({ where }: { where: WhereJournal }) =>
        h.journal.filter((l) => dansJournal(l, where)).length,
      ),
      deleteMany: vi.fn(async ({ where }: { where: WhereJournal }) => {
        const avant = h.journal.length;
        h.journal = h.journal.filter((l) => !dansJournal(l, where));
        return { count: avant - h.journal.length };
      }),
    },
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

/** Les dates des tests sont FIXES : sans horloge figée, la plage ±2 ans les refuserait un jour. */
const MAINTENANT = new Date("2026-10-17T12:00:00Z");

/** `n` invités déjà ajoutés par `userId`, il y a `ilYa` ms. */
const prerempli = (n: number, userId = "u1", ilYa = 0) =>
  Array.from({ length: n }, () => ({
    ip: "geste",
    identifier: `tricount-guest:${userId}`,
    createdAt: new Date(MAINTENANT.getTime() - ilYa),
  }));

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: MAINTENANT });
  h.tricountOn = true;
  h.journal = [];
  h.purgeWhere = null;
  h.session = resaUser;
  h.tricountUpsert.mockResolvedValue({ id: "t1", date: "2026-07-10" });
  h.guestUpsert.mockResolvedValue({ id: "g1", name: "Marc" });
});

describe("POST /api/tricount/guests", () => {
  it("crée l'invité et renvoie son id", async () => {
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ id: "g1", tricountId: "t1", name: "Marc" });
  });

  it("upsert idempotent par (tricountId, name) — même invité deux fois", async () => {
    await POST(req({ date: "2026-07-10", name: "Marc" }));
    const where = h.guestUpsert.mock.calls[0][0].where;
    expect(where).toEqual({ tricountId_name: { tricountId: "t1", name: "Marc" } });
  });

  it("rejette un nom vide", async () => {
    const res = await POST(req({ date: "2026-07-10", name: "   " }));
    expect(res.status).toBe(400);
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("rejette une date invalide", async () => {
    const res = await POST(req({ date: "10-07-2026", name: "Marc" }));
    expect(res.status).toBe(400);
    expect(h.tricountUpsert).not.toHaveBeenCalled();
  });

  it.each(["2026-02-30", "2026-13-01", "2062-07-10"])(
    "rejette une date bien formée mais irréelle ou invraisemblable (%s)",
    async (date) => {
      const res = await POST(req({ date, name: "Marc" }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Date invalide" });
      expect(h.tricountUpsert).not.toHaveBeenCalled();
    },
  );

  it("refuse un compte email seul (même garde que l'ajout de dépense)", async () => {
    h.session = emailOnly;
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(403);
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("refuse sans session", async () => {
    h.session = null;
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tricount/guests — les cas canoniques et les bornes", () => {
  it("répond 404 quand la fonction est coupée", async () => {
    h.tricountOn = false;
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(404);
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("refuse un nom de plus de 40 caractères", async () => {
    // La borne était déclarée (`MAX_GUEST_NAME_LEN`) et appliquée, mais aucun test ne
    // l'exerçait : seul le nom VIDE l'était. Une borne qu'on n'éprouve pas finit par décrire
    // une autre version du code.
    const res = await POST(req({ date: "2026-07-10", name: "M".repeat(41) }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("40") });
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("accepte un nom d'exactement 40 caractères — la borne est inclusive", async () => {
    const res = await POST(req({ date: "2026-07-10", name: "M".repeat(40) }));
    expect(res.status).toBe(200);
  });

  it("REFUSE au-delà de 20 invités en 10 minutes pour un même membre", async () => {
    // Garde-fou anti-emballement : le risque n'est pas l'inconnu malveillant (le club est sur
    // invitation) mais le client qui boucle. Les invités n'étaient bornés que par l'unicité
    // (tricountId, name) — donc pas bornés : il suffit de changer de prénom.
    h.journal = prerempli(20);
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(429);
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("laisse passer juste en dessous de la borne", async () => {
    h.journal = prerempli(19);
    expect((await POST(req({ date: "2026-07-10", name: "Marc" }))).status).toBe(200);
  });

  it("ne se contourne plus en CHANGEANT DE DATE (le compteur suivait la date visée)", async () => {
    // Vingt invités, chacun sur une date différente : l'ancien compte, filtré par
    // `tricount: { date }`, repartait de zéro à chaque date — et chaque date créait au passage
    // un tricount vide.
    for (let i = 1; i <= 20; i++) {
      const date = `2026-07-${String(i).padStart(2, "0")}`;
      expect((await POST(req({ date, name: `Invité ${i}` }))).status).toBe(200);
    }
    const res = await POST(req({ date: "2026-07-21", name: "Encore un" }));
    expect(res.status).toBe(429);
  });

  it("compte PAR MEMBRE, sur une fenêtre de 10 minutes", async () => {
    // Ceux d'un autre membre, ou plus vieux que la fenêtre, ne comptent pas.
    h.journal = [...prerempli(20, "u2"), ...prerempli(20, "u1", 10 * 60_000 + 1000)];
    expect((await POST(req({ date: "2026-07-10", name: "Marc" }))).status).toBe(200);
  });
});

describe("POST /api/tricount/guests — purge des tricounts vides", () => {
  it("efface au passage les tricounts SANS dépense de plus de 24 h, sauf celui de la date visée", async () => {
    await POST(req({ date: "2026-07-10", name: "Marc" }));
    const where = h.purgeWhere as {
      expenses: unknown;
      createdAt: { lt: Date };
      date: unknown;
    };
    expect(where.expenses).toEqual({ none: {} });
    expect(where.date).toEqual({ not: "2026-07-10" });
    expect(MAINTENANT.getTime() - where.createdAt.lt.getTime()).toBe(24 * 3600_000);
  });

  it("ne purge rien quand la requête est refusée", async () => {
    h.journal = prerempli(20);
    await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(h.purgeWhere).toBeNull();
  });
});
