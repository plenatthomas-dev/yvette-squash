import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LES RÉACTIONS.
//
// Deux invariants portent toute la fonction, et aucun des deux ne se relit dans le code :
//  1. LA BASCULE EST IDEMPOTENTE. Une pastille se re-clique par réflexe, et deux clics rapides
//     ne doivent jamais laisser deux lignes derrière eux.
//  2. LA LISTE DES EMOJI EST FERMÉE. Sans elle, la colonne accepte n'importe quelle chaîne
//     d'un client bricolé — et une rangée de vingt pastilles différentes ne dit plus rien.
//
// Troisième point, plus discret : une réaction NE NOTIFIE PAS. C'est même sa raison d'être —
// dix « ok » écrits coûtent dix notifications, dix pouces levés n'en coûtent aucune.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  message: { id: "m1" } as null | { id: string },
  /** La réaction déjà posée par ce membre sur cet emoji, ou `null`. */
  existante: null as null | { id: string },
  recentCount: 0,
  cree: null as null | Record<string, unknown>,
  supprime: null as null | string,
  diffuse: null as null | [string, Record<string, unknown>],
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ forum: h.forumOn }) }));
vi.mock("@/lib/forum-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/forum-realtime")>()),
  broadcastForum: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    h.diffuse = [event, payload];
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    forumMessage: { findUnique: vi.fn(async () => h.message) },
    forumReaction: {
      findUnique: vi.fn(async () => h.existante),
      count: vi.fn(async () => h.recentCount),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.cree = args.data;
        return { id: "r1" };
      }),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        h.supprime = args.where.id;
        return {};
      }),
    },
    user: { findUnique: vi.fn(async () => ({ displayName: "Thomas" })) },
  },
}));

import { POST } from "./route";

const req = (emoji: unknown = "👍") =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ emoji }),
  }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "m1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.message = { id: "m1" };
  h.existante = null;
  h.recentCount = 0;
  h.cree = null;
  h.supprime = null;
  h.diffuse = null;
});

describe("gardes — le même ordre que partout dans l'appli", () => {
  it("404 quand la fonction est coupée, AVANT de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 sur un message qui n'existe pas", async () => {
    h.message = null;
    expect((await POST(req(), ctx)).status).toBe(404);
    expect(h.cree).toBeNull();
  });
});

describe("la liste des emoji est FERMÉE", () => {
  it("accepte une réaction de la palette", async () => {
    expect((await POST(req("👍"), ctx)).status).toBe(200);
  });

  it("refuse un emoji hors palette, sans rien écrire", async () => {
    expect((await POST(req("🤮"), ctx)).status).toBe(400);
    expect(h.cree).toBeNull();
    expect(h.diffuse).toBeNull();
  });

  it("refuse une chaîne quelconque et un non-texte", async () => {
    for (const v of ["<script>", "", 42, null]) {
      expect((await POST(req(v), ctx)).status).toBe(400);
    }
    expect(h.cree).toBeNull();
  });

  it("refuse un corps sans `emoji` du tout", async () => {
    const vide = {
      cookies: { get: () => ({ value: "sid" }) },
      json: async () => ({}),
    } as unknown as NextRequest;
    expect((await POST(vide, ctx)).status).toBe(400);
    expect(h.cree).toBeNull();
  });
});

describe("la bascule", () => {
  it("pose la réaction quand elle n'existe pas", async () => {
    const res = await POST(req("💪"), ctx);
    expect(await res.json()).toEqual({ on: true });
    expect(h.cree).toEqual({ messageId: "m1", userId: "u1", emoji: "💪" });
    expect(h.supprime).toBeNull();
  });

  it("la retire quand elle existe déjà — même geste, même route", async () => {
    h.existante = { id: "r-vieille" };
    const res = await POST(req("💪"), ctx);
    expect(await res.json()).toEqual({ on: false });
    expect(h.supprime).toBe("r-vieille");
    expect(h.cree).toBeNull();
  });
});

describe("la diffusion", () => {
  // On diffuse le DELTA et non le décompte : deux clics simultanés sur deux appareils
  // enverraient sinon deux totaux concurrents, dont le dernier arrivé écraserait l'autre.
  it("porte un delta nommé, pas un total", async () => {
    await POST(req("🎾"), ctx);
    expect(h.diffuse?.[0]).toBe("reaction");
    expect(h.diffuse?.[1]).toEqual({
      messageId: "m1",
      emoji: "🎾",
      userId: "u1",
      userName: "Thomas",
      on: true,
    });
    expect(h.diffuse?.[1]).not.toHaveProperty("count");
  });

  it("annonce le retrait avec le même delta, inversé", async () => {
    h.existante = { id: "r1" };
    await POST(req("🎾"), ctx);
    expect(h.diffuse?.[1].on).toBe(false);
  });
});

describe("garde-fou d'emballement", () => {
  it("laisse passer un usage normal", async () => {
    h.recentCount = 119;
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("refuse en 429 au-delà, sans écrire ni diffuser", async () => {
    h.recentCount = 120;
    expect((await POST(req(), ctx)).status).toBe(429);
    expect(h.cree).toBeNull();
    expect(h.diffuse).toBeNull();
  });
});
