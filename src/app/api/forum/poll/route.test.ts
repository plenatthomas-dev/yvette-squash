import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA CRÉATION D'UN SONDAGE.
//
// Le choix de conception que ces tests verrouillent : LE SONDAGE EST UN MESSAGE. La question
// devient le `body` du message porteur, et le sondage s'y accroche. C'est ce qui lui donne
// gratuitement sa place chronologique, la suppression, la purge à 12 mois et la notification —
// aucun cycle de vie propre. Si quelqu'un détache un jour le sondage du message, ces tests
// tombent, et c'est exactement ce qu'on veut.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  recentCount: 0,
  /** Le `data` passé à `forumMessage.create` : c'est là qu'on lit la question. */
  message: null as null | Record<string, unknown>,
  /** Le `data` passé à `forumPoll.create` : c'est là qu'on lit les options. */
  poll: null as null | Record<string, unknown>,
  pushed: null as null | [string[], Record<string, unknown>],
  diffuse: null as null | [string, Record<string, unknown>],
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ forum: h.forumOn }) }));
vi.mock("@/lib/push", () => ({
  pushToUsers: vi.fn(async (ids: string[], payload: Record<string, unknown>) => {
    h.pushed = [ids, payload];
    return { recipients: ids.length, sent: ids.length };
  }),
}));
vi.mock("@/lib/forum-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/forum-realtime")>()),
  broadcastForum: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    h.diffuse = [event, payload];
  }),
}));

const tx = {
  forumMessage: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      h.message = args.data;
      return {
        id: "m-sondage",
        body: args.data.body,
        authorId: args.data.authorId,
        createdAt: new Date("2026-09-05T18:42:00Z"),
        replyToId: null,
        replyToAuthor: null,
        replyToExcerpt: null,
        author: { displayName: "Thomas" },
      };
    }),
  },
  forumPoll: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      h.poll = args.data;
      const create = (args.data.options as { create: { label: string }[] }).create;
      return {
        id: "p1",
        messageId: "m-sondage",
        closedAt: null,
        options: create.map((o, i) => ({ id: `o${i}`, label: o.label, votes: [] })),
      };
    }),
  },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    forumMessage: { count: vi.fn(async () => h.recentCount) },
    user: { findMany: vi.fn(async () => [{ id: "u2" }, { id: "u3" }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));

import { POST } from "./route";

const req = (
  question: unknown = "Resto après ?",
  options: unknown = ["Chez Marco", "Le Bistrot"],
) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ question, options }),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.recentCount = 0;
  h.message = null;
  h.poll = null;
  h.pushed = null;
  h.diffuse = null;
});

describe("gardes", () => {
  it("404 quand la fonction est coupée, AVANT de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await POST(req())).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await POST(req())).status).toBe(401);
  });

  it("429 au-delà de la limite de débit, sans rien écrire", async () => {
    h.recentCount = 30;
    expect((await POST(req())).status).toBe(429);
    expect(h.message).toBeNull();
  });
});

describe("le nombre d'options", () => {
  it("refuse une seule réponse : ce n'est pas un choix", async () => {
    expect((await POST(req("Jeudi ?", ["Oui"]))).status).toBe(400);
    expect(h.poll).toBeNull();
  });

  it("refuse au-delà de six", async () => {
    const sept = ["a", "b", "c", "d", "e", "f", "g"];
    expect((await POST(req("Quel jour ?", sept))).status).toBe(400);
  });

  it("accepte deux réponses, et six", async () => {
    expect((await POST(req("A ?", ["x", "y"]))).status).toBe(201);
    expect((await POST(req("B ?", ["a", "b", "c", "d", "e", "f"]))).status).toBe(201);
  });

  // Un champ laissé vide dans le formulaire ne doit pas compter comme une réponse : trois
  // champs dont un vide font DEUX options, et la route doit le voir ainsi.
  it("ne compte pas les réponses vides", async () => {
    await POST(req("Jeudi ?", ["Oui", "   ", "Non"]));
    expect((h.poll?.options as { create: unknown[] }).create).toHaveLength(2);
  });

  it("refuse quand il ne reste qu'une réponse une fois les vides retirées", async () => {
    expect((await POST(req("Jeudi ?", ["Oui", "", "  "]))).status).toBe(400);
  });

  // Deux options identiques séparent les voix de ceux qui voulaient dire la même chose : le
  // résultat devient indécidable.
  it("dédoublonne les réponses identiques, et refuse s'il n'en reste qu'une", async () => {
    expect((await POST(req("Jeudi ?", ["Oui", "Oui"]))).status).toBe(400);
  });

  it("refuse une liste absente ou d'un autre type", async () => {
    expect((await POST(req("Jeudi ?", null))).status).toBe(400);
    expect((await POST(req("Jeudi ?", "Oui,Non"))).status).toBe(400);
  });

  it("refuse une question vide", async () => {
    expect((await POST(req("   ", ["a", "b"]))).status).toBe(400);
  });
});

describe("le sondage EST un message", () => {
  it("écrit la question dans le `body` du message porteur", async () => {
    await POST(req("Resto après le match ?"));
    expect(h.message?.body).toBe("Resto après le match ?");
    expect(h.message?.authorId).toBe("u1");
  });

  it("accroche le sondage à ce message, options ordonnées", async () => {
    await POST(req("Quel jour ?", ["Jeudi", "Vendredi", "Samedi"]));
    expect(h.poll?.messageId).toBe("m-sondage");
    expect(
      (h.poll?.options as { create: { label: string; position: number }[] }).create,
    ).toEqual([
      { label: "Jeudi", position: 0 },
      { label: "Vendredi", position: 1 },
      { label: "Samedi", position: 2 },
    ]);
  });

  it("notifie comme un message ordinaire, sous le même tag", async () => {
    await POST(req("Resto après ?"));
    expect(h.pushed?.[0]).toEqual(["u2", "u3"]);
    expect(h.pushed?.[1].tag).toBe("forum");
    expect(h.pushed?.[1].body).toBe("Resto après ?");
  });

  it("diffuse le message ET le sondage ensemble, pour éviter un aller-retour", async () => {
    await POST(req("Resto après ?"));
    expect(h.diffuse?.[0]).toBe("message");
    expect(h.diffuse?.[1].id).toBe("m-sondage");
    expect((h.diffuse?.[1].poll as { messageId: string }).messageId).toBe("m-sondage");
  });
});
