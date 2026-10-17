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
  /**
   * Le journal des gestes (`LoginAttempt`, cf. lib/geste-debit.ts), en mémoire. Il HONORE
   * `ip`, `identifier` et les bornes de `createdAt` : une vraie rafale s'y mesure.
   */
  journal: [] as { ip: string; identifier: string; createdAt: Date }[],
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
    forumMessage: { findUnique: vi.fn(async () => h.message) },
    // Le `where` est HONORÉ, et non ignoré : le remplacer par `{}` ferait de la limite un
    // plafond global au club, et c'est le test « un seul membre » qui rougirait.
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
    forumReaction: {
      findUnique: vi.fn(async () => h.existante),
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
  h.journal = [];
  h.cree = null;
  h.supprime = null;
  h.diffuse = null;
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
  /** `n` gestes déjà journalisés, il y a `ilYa` ms. */
  const prerempli = (n: number, ilYa = 0, identifier = "forum-react:u1") =>
    Array.from({ length: n }, () => ({
      ip: "geste", identifier, createdAt: new Date(Date.now() - ilYa),
    }));

  it("bascule ×120 : re-cliquer la même pastille à l'infini finit en 429", async () => {
    // LE DÉFAUT : la limite comptait les réactions PRÉSENTES, or la bascule pose puis retire la
    // même ligne — le compteur ne dépassait jamais 1, et chaque clic diffusait sur Pusher.
    for (let i = 0; i < 120; i++) {
      h.existante = i % 2 ? { id: "r1" } : null;
      expect((await POST(req("👍"), ctx)).status).toBe(200);
    }
    h.cree = null;
    h.supprime = null;
    h.diffuse = null;
    h.existante = null;
    expect((await POST(req("👍"), ctx)).status).toBe(429);
    expect(h.cree).toBeNull();
    expect(h.supprime).toBeNull();
    expect(h.diffuse).toBeNull();
  });

  it("laisse passer un usage normal", async () => {
    h.journal = prerempli(119);
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("compte les gestes d'UN SEUL membre, sur une fenêtre glissante de 10 min", async () => {
    h.journal = [...prerempli(120, 0, "forum-react:u2"), ...prerempli(120, 10 * 60_000 + 1000)];
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("refuse en 429 au-delà, sans écrire ni diffuser", async () => {
    h.journal = prerempli(120);
    expect((await POST(req(), ctx)).status).toBe(429);
    expect(h.cree).toBeNull();
    expect(h.diffuse).toBeNull();
  });
});
