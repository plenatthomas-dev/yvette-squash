import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

// LA SUPPRESSION D'UN MESSAGE.
//
// C'est ici que le fil du club s'écarte du fil des frais partagés, où seul l'auteur efface :
// un fil public à tous les membres a besoin de quelqu'un capable de retirer une insulte ou une
// donnée personnelle publiée par erreur. L'admin l'est. Le reste des tests verrouille qu'il
// est le SEUL à l'être, et que le refus ne renseigne personne sur ce qui existe.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  message: { id: "m1", authorId: "u1" } as null | { id: string; authorId: string },
  deleted: null as null | string,
  diffuse: null as null | [string, Record<string, unknown>],
  /** Toutes les écritures vues, pour prouver qu'AUCUNE n'a lieu en dehors du `delete`. */
  ecritures: [] as string[],
  /** Ce que `delete` doit jeter, pour éprouver la course entre deux suppressions. */
  jette: null as null | Error,
}));

// `normalizeEmail` est réexporté pour `admin.ts`, qui lit l'allowlist avec : le neutraliser
// ferait passer le test de casse pour de mauvaises raisons.
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
    forumMessage: {
      findUnique: vi.fn(async () => h.message),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        h.ecritures.push("delete");
        if (h.jette) throw h.jette;
        h.deleted = args.where.id;
        return {};
      }),
      // Présent MAIS JAMAIS APPELÉ : c'est ce que le dernier test de ce fichier verrouille.
      // Le blanchiment d'instantanés dénormalisés n'existe plus — il n'y a plus d'instantané.
      updateMany: vi.fn(async () => {
        h.ecritures.push("updateMany");
        return { count: 0 };
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { DELETE } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "m1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "chef@example.com";
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.message = { id: "m1", authorId: "u1" };
  h.deleted = null;
  h.diffuse = null;
  h.ecritures = [];
  h.jette = null;
});

describe("DELETE /api/forum/{id}", () => {
  it("404 quand la fonction est coupée, avant même de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await DELETE(req(), ctx)).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await DELETE(req(), ctx)).status).toBe(401);
  });

  it("laisse l'auteur effacer le sien", async () => {
    expect((await DELETE(req(), ctx)).status).toBe(200);
    expect(h.deleted).toBe("m1");
  });

  // Le fil est lu par tout le club : sans modérateur, une insulte ou un numéro de téléphone
  // publié par erreur y resterait douze mois.
  it("laisse l'ADMIN effacer celui d'un autre", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "chef@example.com" };
    h.message = { id: "m1", authorId: "u2" };
    expect((await DELETE(req(), ctx)).status).toBe(200);
    expect(h.deleted).toBe("m1");
  });

  it("reconnaît l'admin quelle que soit la casse de son adresse", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "CHEF@Example.com" };
    h.message = { id: "m1", authorId: "u2" };
    expect((await DELETE(req(), ctx)).status).toBe(200);
  });

  // 404 et non 403 : distinguer les deux apprendrait à un curieux quels identifiants existent.
  it("répond 404, et non 403, sur le message d'un autre", async () => {
    h.session = { userId: "quidam", displayName: "Quidam", email: "quidam@example.com" };
    h.message = { id: "m1", authorId: "u2" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.deleted).toBeNull();
    expect(h.diffuse).toBeNull();
  });

  it("404 quand le message n'existe pas — le même que ci-dessus, indiscernable", async () => {
    h.message = null;
    expect((await DELETE(req(), ctx)).status).toBe(404);
    expect(h.deleted).toBeNull();
  });

  // Sans cette diffusion, un message supprimé resterait affiché chez les membres qui ont le
  // fil ouvert — précisément ceux que la modération vise à protéger.
  it("referme le message chez tout le monde, sans attendre un rafraîchissement", async () => {
    await DELETE(req(), ctx);
    expect(h.diffuse).toEqual(["deleted", { id: "m1" }]);
  });
});

// SUPPRIMER, C'EST AUSSI EFFACER LES CITATIONS — ET C'EST LA BASE QUI LE FAIT.
//
// Une version antérieure dénormalisait un instantané de la cible chez chacune de ses réponses,
// que cette route devait alors blanchir. Le dispositif ne couvrait qu'UN CHEMIN SUR TROIS : ni
// la purge des 12 mois ni la cascade de suppression d'un compte ne passent par ici, et le texte
// d'un membre survivait donc à son effacement comme à son départ. Il n'y a plus d'instantané :
// `ON DELETE SET NULL` sur `replyToId` fait disparaître la citation entière, partout, toujours.
describe("DELETE — ce que le message laisse derrière lui", () => {
  it("supprime le message, et RIEN d'autre : plus aucun instantané à blanchir", async () => {
    await DELETE(req(), ctx);
    expect(h.deleted).toBe("m1");
    // Le test le plus important du fichier : une seule écriture. Si un blanchiment réapparaît,
    // c'est qu'une copie de texte est revenue quelque part.
    expect(h.ecritures).toEqual(["delete"]);
  });

  it("n'écrit rien quand le refus tombe", async () => {
    h.session = { userId: "quidam", displayName: "Quidam", email: "quidam@example.com" };
    h.message = { id: "m1", authorId: "u2" };
    await DELETE(req(), ctx);
    expect(h.ecritures).toEqual([]);
    expect(h.deleted).toBeNull();
  });

  // LE CAS RÉEL : l'auteur supprime depuis son téléphone pendant que l'admin supprime depuis
  // son ordinateur — ou un simple double-clic, que rien ne garde côté écran. La ligne est déjà
  // partie, Prisma jette P2025, et la route rendait un 500 pour un geste qui a abouti.
  it("traite une suppression jouée deux fois comme un succès, pas comme un 500", async () => {
    h.jette = new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
      code: "P2025",
      clientVersion: "6",
    });
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    // Et le fil se referme quand même chez les autres : c'est le seul état vrai.
    expect(h.diffuse).toEqual(["deleted", { id: "m1" }]);
  });
});
