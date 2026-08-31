import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  match: null as null | Record<string, unknown>,
  updated: null as null | Record<string, unknown>,
  released: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => {
  const tx = {
    interclubMatch: {
      findUnique: vi.fn(async () => h.match),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return {};
      }),
    },
    interclub: { update: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      interclubMatch: {
        updateMany: vi.fn(async (args: Record<string, unknown>) => {
          h.released = args;
          return { count: 1 };
        }),
      },
    },
  };
});

import { POST, DELETE } from "./route";

const ctx = { params: Promise.resolve({ id: "f1", mid: "m1" }) };
const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

const RECENT = new Date(Date.now() - 60_000);
const OLD = new Date(Date.now() - 60 * 60_000);

const freshMatch = () => ({
  id: "m1",
  interclubId: "f1",
  status: "pending",
  scorerId: null,
  scorerClaimedAt: null,
  updatedAt: OLD,
  homeDisplayName: "Thomas",
  awayName: "Dupont",
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.match = freshMatch();
  h.updated = null;
  h.released = null;
});

describe("POST .../claim", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 si le match appartient à une autre rencontre", async () => {
    h.match = { ...freshMatch(), interclubId: "AUTRE" };
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("prend la main sans déclarer la rencontre commencée", async () => {
    // Prendre le marquage n'est pas jouer. Écrire `status: "live"` ici empêchait la
    // notification de début de partir (la transition n'avait plus lieu au premier point) et
    // laissait la rencontre « En cours » à vie si l'on relâchait aussitôt.
    expect((await POST(req(), ctx)).status).toBe(200);
    expect(h.updated).toMatchObject({ scorerId: "u1" });
    expect(h.updated).not.toHaveProperty("status");
  });

  it("refuse un match que quelqu'un d'autre marque activement", async () => {
    h.match = { ...freshMatch(), scorerId: "u2", scorerClaimedAt: RECENT, updatedAt: RECENT };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/marque déjà/);
  });

  it("reprend une prise ABANDONNÉE : un téléphone à plat ne doit pas geler le match", async () => {
    h.match = { ...freshMatch(), scorerId: "u2", scorerClaimedAt: OLD, updatedAt: OLD };
    expect((await POST(req(), ctx)).status).toBe(200);
    expect(h.updated).toMatchObject({ scorerId: "u1" });
  });

  it("reprendre son propre marquage est toujours possible", async () => {
    h.match = { ...freshMatch(), scorerId: "u1", scorerClaimedAt: RECENT, updatedAt: RECENT };
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("refuse de marquer un match déjà terminé", async () => {
    h.match = { ...freshMatch(), status: "done" };
    expect((await POST(req(), ctx)).status).toBe(409);
  });

  it("ne touche pas au statut du match, quel qu'il soit", async () => {
    h.match = { ...freshMatch(), status: "live" };
    await POST(req(), ctx);
    expect(h.updated).not.toHaveProperty("status");
  });

  it("refuse de prendre le marquage tant que le joueur de l'équipe n'est pas désigné", async () => {
    h.match = { ...freshMatch(), homeDisplayName: "À désigner" };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/désigne les deux joueurs/i);
    expect(h.updated).toBeNull();
  });

  it("refuse de prendre le marquage tant que l'adversaire n'est pas désigné", async () => {
    h.match = { ...freshMatch(), awayName: "À désigner" };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    expect(h.updated).toBeNull();
  });
});

describe("DELETE .../claim", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await DELETE(req(), ctx)).status).toBe(401);
  });

  it("ne relâche que SA propre prise", async () => {
    expect((await DELETE(req(), ctx)).status).toBe(200);
    expect(h.released).toMatchObject({
      where: { id: "m1", interclubId: "f1", scorerId: "u1" },
      data: { scorerId: null, scorerClaimedAt: null },
    });
  });
});
