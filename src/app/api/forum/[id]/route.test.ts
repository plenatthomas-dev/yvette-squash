import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

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
  /** Ce que l'`updateMany` a blanchi, et sur quel critère : les citations de la cible. */
  blanchi: null as null | { where: Record<string, unknown>; data: Record<string, unknown> },
  /** L'ordre réel des écritures, pour prouver qu'elles partent ENSEMBLE. */
  ordre: [] as string[],
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
      // Les deux écritures sont passées à `$transaction` sous forme de PROMESSES déjà lancées
      // (la forme tableau de Prisma) : elles s'exécutent donc à l'appel, et c'est leur effet
      // qu'on observe ici — pas leur mise en file.
      delete: vi.fn(async (args: { where: { id: string } }) => {
        h.ordre.push("delete");
        h.deleted = args.where.id;
        return {};
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          h.ordre.push("blanchi");
          h.blanchi = args;
          return { count: 1 };
        },
      ),
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
  h.blanchi = null;
  h.ordre = [];
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

// SUPPRIMER, C'EST AUSSI EFFACER LES CITATIONS.
//
// Les réponses gardent un instantané de ce à quoi elles répondent, pour s'afficher sans
// jointure et survivre à la purge des 12 mois. Sans le blanchiment ci-dessous, effacer son
// message en laisserait le texte lisible, signé de son nom, dans chaque réponse reçue — la
// note de confidentialité promet exactement le contraire.
describe("DELETE — ce que le message laisse derrière lui", () => {
  it("blanchit l'instantané chez les réponses, sans supprimer les réponses", async () => {
    await DELETE(req(), ctx);
    expect(h.blanchi?.where).toEqual({ replyToId: "m1" });
    expect(h.blanchi?.data).toEqual({ replyToAuthor: null, replyToExcerpt: null });
    // Une seule suppression : celle du message visé. Les réponses restent.
    expect(h.deleted).toBe("m1");
  });

  it("blanchit AVANT de supprimer, et dans la même transaction", async () => {
    await DELETE(req(), ctx);
    // L'ordre compte : la clé étrangère passerait à NULL au `delete`, et l'`updateMany` ne
    // retrouverait alors plus aucune ligne à blanchir.
    expect(h.ordre).toEqual(["blanchi", "delete"]);
  });

  it("ne touche à rien quand le refus tombe", async () => {
    h.session = { userId: "quidam", displayName: "Quidam", email: "quidam@example.com" };
    h.message = { id: "m1", authorId: "u2" };
    await DELETE(req(), ctx);
    expect(h.blanchi).toBeNull();
    expect(h.deleted).toBeNull();
  });
});
