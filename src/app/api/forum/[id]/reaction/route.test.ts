import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

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
  /** Le `where` du dernier `count` : c'est lui qui borne la limite à UN membre. */
  countWhere: null as null | Record<string, unknown>,
  cree: null as null | Record<string, unknown>,
  supprime: null as null | string,
  diffuse: null as null | [string, Record<string, unknown>],
  /** Ce que l'écriture doit jeter : la course entre deux clics se joue là. */
  jette: null as null | Error,
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
      // Le `where` est CAPTURÉ, et non ignoré : le remplacer par `{}` dans la route ferait de
      // la limite un plafond global au club — 120 réactions par dix minutes pour tout le
      // monde — sans qu'aucun test de ce fichier ne rougisse.
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        h.countWhere = args?.where ?? null;
        return h.recentCount;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (h.jette) throw h.jette;
        h.cree = args.data;
        return { id: "r1" };
      }),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        if (h.jette) throw h.jette;
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
  h.countWhere = null;
  h.jette = null;
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

// LA COURSE QUE CES TESTS FERMENT. La bascule lit puis écrit, sans transaction. Deux clics à
// 200 ms d'intervalle, ou deux appareils : les deux lectures rendent `null`, les deux écritures
// partent, la seconde viole l'index unique. La route rendait alors 500, et l'écran rembobinait
// son affichage optimiste vers « pas de réaction » ALORS QUE LA BASE EN AVAIT UNE — un mensonge
// qui durait jusqu'au rechargement. La base tient bien l'invariant, mais elle le tient en
// JETANT : c'est à la route de traduire ce jet en succès.
describe("deux clics qui se croisent", () => {
  it("traite une réaction déjà posée comme un succès, pas comme un 500", async () => {
    h.existante = null;
    h.jette = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "6",
    });
    const res = await POST(req("👍"), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).on).toBe(true);
    // Le delta part quand même : il décrit l'état atteint, et il est idempotent chez tous.
    expect(h.diffuse?.[1].on).toBe(true);
  });

  it("traite une réaction déjà retirée comme un succès, pas comme un 500", async () => {
    h.existante = { id: "r1" };
    h.jette = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "6",
    });
    const res = await POST(req("👍"), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).on).toBe(false);
    expect(h.diffuse?.[1].on).toBe(false);
  });

  // Ceinture : une erreur qui n'est PAS une course doit continuer de remonter. Avaler tout ce
  // qui passe transformerait une panne en succès silencieux.
  it("laisse remonter une erreur qui n'est pas une course", async () => {
    h.existante = null;
    h.jette = new Error("la base est tombée");
    await expect(POST(req("👍"), ctx)).rejects.toThrow("la base est tombée");
  });
});

describe("garde-fou d'emballement", () => {
  it("compte les réactions d'UN SEUL membre, sur une fenêtre glissante", async () => {
    await POST(req("👍"), ctx);
    expect(h.countWhere?.userId).toBe("u1");
    const gte = (h.countWhere?.createdAt as { gte: Date }).gte;
    expect(Math.round((Date.now() - gte.getTime()) / 60_000)).toBe(10);
  });

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
