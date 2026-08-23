import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Un invité hors asso n'a ni compte ni connexion : cette route le crée (ou le
// retrouve, idempotent) sur le tricount du jour choisi. Même garde que l'ajout
// d'une dépense : réservé aux comptes ResaMania (email seul = lecture/validation
// uniquement).

const h = vi.hoisted(() => ({
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
    tricount: { upsert: h.tricountUpsert },
    tricountGuest: { upsert: h.guestUpsert },
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
