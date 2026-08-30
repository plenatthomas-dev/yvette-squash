import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un invité hors asso n'a ni compte ni connexion : cette route le crée (ou le
// retrouve, idempotent) sur le tricount du jour choisi. Même garde que l'ajout
// d'une dépense : réservé aux comptes ResaMania (email seul = lecture/validation
// uniquement).

const h = vi.hoisted(() => ({
  /** Drapeau de fonction : le 404 « coupée » est le premier cas canonique. */
  tricountOn: true,
  /** Combien d invités ont déjà été créés dans la fenêtre. */
  guestCount: 0,
  countWhere: null as null | Record<string, unknown>,
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
vi.mock("@/lib/db", () => ({
  prisma: {
    tricount: { upsert: h.tricountUpsert },
    tricountGuest: {
      count: vi.fn(async (a: { where: Record<string, unknown> }) => {
        h.countWhere = a.where;
        return h.guestCount;
      }), upsert: h.guestUpsert },
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

beforeEach(() => {
  vi.clearAllMocks();
  h.tricountOn = true;
  h.guestCount = 0;
  h.countWhere = null;
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

  it("REFUSE au-delà de 20 invités en 10 minutes sur la même date", async () => {
    // Garde-fou anti-emballement, même motif que le fil de commentaires : le risque n'est pas
    // l'inconnu malveillant (le club est sur invitation) mais le client qui boucle. Les invités
    // n'étaient bornés que par l'unicité (tricountId, name) — donc pas bornés : il suffit de
    // changer de prénom.
    h.guestCount = 20;
    const res = await POST(req({ date: "2026-07-10", name: "Marc" }));
    expect(res.status).toBe(429);
    expect(h.guestUpsert).not.toHaveBeenCalled();
  });

  it("laisse passer juste en dessous de la borne", async () => {
    h.guestCount = 19;
    expect((await POST(req({ date: "2026-07-10", name: "Marc" }))).status).toBe(200);
  });

  it("compte sur une FENÊTRE de 10 minutes, et sur la date visée", async () => {
    // Une fenêtre qu'on n'inspecte pas peut valoir 10 ms ou 10 jours sans qu'aucun test bouge.
    const avant = Date.now();
    await POST(req({ date: "2026-07-10", name: "Marc" }));
    const where = h.countWhere as { createdAt: { gte: Date }; tricount: { date: string } };
    expect(where.tricount).toEqual({ date: "2026-07-10" });
    const fenetre = avant - where.createdAt.gte.getTime();
    expect(fenetre).toBeGreaterThanOrEqual(10 * 60_000 - 50);
    expect(fenetre).toBeLessThanOrEqual(10 * 60_000 + 50);
  });
});
