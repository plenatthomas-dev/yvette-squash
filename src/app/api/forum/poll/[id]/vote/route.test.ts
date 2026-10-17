import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

// LE VOTE, À CHOIX MULTIPLE.
//
// Deux propriétés portent la route, et aucune ne se relit dans le code :
//  1. LE VOTE REMPLACE, il n'ajoute pas. Le corps porte l'ENSEMBLE des cases cochées, et la
//     route efface d'abord tout ce que le membre avait coché sur CE sondage. Un différentiel
//     obligerait le client à connaître un état qu'il peut avoir perdu entre deux diffusions.
//     Corollaire : une liste vide est un retrait de vote légitime, pas une erreur.
//  2. LES OPTIONS DOIVENT APPARTENIR À CE SONDAGE. Sans ce contrôle, un identifiant emprunté
//     à un autre sondage y ajouterait une voix en douce.
//  3. LE REMPLACEMENT EST ATOMIQUE. « J'efface toutes mes cases, je repose celles que je
//     veux » n'a de sens que si les deux ordres voient le même instantané. En isolation par
//     défaut ils ne le voyaient pas : deux clics à 150 ms d'intervalle, et le `deleteMany` du
//     second ne voyait pas la ligne que le premier venait d'insérer — violation d'unicité, 500,
//     transaction annulée en entier, et le second vote PERDU. D'où la sérialisation.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  poll: {
    id: "p1",
    closedAt: null as Date | null,
    options: [{ id: "o1" }, { id: "o2" }, { id: "o3" }],
    message: { authorId: "u1" },
  } as null | Record<string, unknown>,
  efface: null as null | Record<string, unknown>,
  ecrit: null as null | Record<string, unknown>[],
  maj: null as null | Record<string, unknown>,
  diffuse: null as null | [string, Record<string, unknown>],
  /** Le niveau d'isolation réclamé à `$transaction`. Le défaut ne suffit pas ici. */
  isolation: null as null | string,
  /** Combien de fois la transaction a été jouée : le rejeu sur conflit se mesure. */
  essais: 0,
  /** Ce que `createMany` doit jeter au premier essai, pour éprouver le rejeu. */
  jette: null as null | Error,
  /**
   * Le journal des gestes (`LoginAttempt`, cf. lib/geste-debit.ts), en mémoire. Il HONORE
   * `ip`, `identifier` et les bornes de `createdAt` : c'est ce qui permet de mesurer une
   * vraie rafale — un chiffre fixe aurait répondu à la place de la route.
   */
  journal: [] as { ip: string; identifier: string; createdAt: Date }[],
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
vi.mock("@/lib/forum-db", () => ({
  relireSondage: vi.fn(async (id: string) => ({
    id,
    messageId: "m1",
    closedAt: null,
    options: [],
  })),
}));
vi.mock("@/lib/db", () => {
  // Le double doit servir LES DEUX formes de `$transaction` : le tableau de promesses, et la
  // FONCTION de rappel — c'est celle qu'emploie `serializableTransaction`, qui est aussi la
  // seule à pouvoir demander un niveau d'isolation. Ne servir que la première laissait la
  // route ne pas s'exécuter du tout.
  const client: Record<string, unknown> = {
    forumPoll: {
      findUnique: vi.fn(async () => h.poll),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.maj = args.data;
        return {};
      }),
    },
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
    forumPollVote: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.efface = args.where;
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        if (h.jette) {
          const e = h.jette;
          h.jette = null;
          throw e;
        }
        h.ecrit = args.data;
        return { count: args.data.length };
      }),
    },
  };
  client.$transaction = vi.fn(
    async (arg: unknown, opts?: { isolationLevel?: string }) => {
      if (typeof arg === "function") {
        h.essais += 1;
        h.isolation = opts?.isolationLevel ?? null;
        return (arg as (tx: unknown) => Promise<unknown>)(client);
      }
      return Promise.all(arg as Promise<unknown>[]);
    },
  );
  return { prisma: client };
});

import { POST, PATCH } from "./route";
import { prisma } from "@/lib/db";

/** Le double de Prisma, retypé pour lire ce qui a été passé à `createMany`. */
const client = prisma as unknown as {
  forumPollVote: { createMany: ReturnType<typeof vi.fn> };
};

const vote = (optionIds: unknown) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ optionIds }),
  }) as unknown as NextRequest;
const clore = (closed: unknown) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ closed }),
  }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "chef@example.com";
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.poll = {
    id: "p1",
    closedAt: null,
    options: [{ id: "o1" }, { id: "o2" }, { id: "o3" }],
    message: { authorId: "u1" },
  };
  h.efface = null;
  h.ecrit = null;
  h.maj = null;
  h.diffuse = null;
  h.isolation = null;
  h.essais = 0;
  h.jette = null;
  h.journal = [];
});

describe("gardes", () => {
  it("404 quand la fonction est coupée, AVANT de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await POST(vote(["o1"]), ctx)).status).toBe(404);
    expect((await PATCH(clore(true), ctx)).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await POST(vote(["o1"]), ctx)).status).toBe(401);
  });

  it("404 sur un sondage inexistant", async () => {
    h.poll = null;
    expect((await POST(vote(["o1"]), ctx)).status).toBe(404);
    expect(h.ecrit).toBeNull();
  });
});

describe("le choix MULTIPLE", () => {
  it("écrit une ligne PAR case cochée", async () => {
    await POST(vote(["o1", "o3"]), ctx);
    expect(h.ecrit).toEqual([
      { optionId: "o1", userId: "u1" },
      { optionId: "o3", userId: "u1" },
    ]);
  });

  // C'est la propriété qui rend le vote idempotent : re-voter ne cumule jamais.
  it("efface d'abord TOUT ce que le membre avait coché sur ce sondage", async () => {
    await POST(vote(["o2"]), ctx);
    expect(h.efface).toEqual({ userId: "u1", optionId: { in: ["o1", "o2", "o3"] } });
  });

  it("accepte une liste vide : c'est un retrait de vote, pas une erreur", async () => {
    const res = await POST(vote([]), ctx);
    expect(res.status).toBe(200);
    expect(h.efface).not.toBeNull();
    // Rien à réinsérer : on n'émet pas un `createMany` vide, qui ne serait qu'un aller-retour.
    expect(h.ecrit).toBeNull();
  });

  it("dédoublonne les identifiants répétés", async () => {
    await POST(vote(["o1", "o1"]), ctx);
    expect(h.ecrit).toHaveLength(1);
  });
});

// LES DEUX PROPRIÉTÉS QUI FERMENT LA COURSE. Elles ne se relisent pas dans le code appelant :
// sans elles, la route redevient un `deleteMany` + `createMany` en isolation par défaut, et le
// second de deux votes rapprochés est perdu avec un 500.
describe("le remplacement est ATOMIQUE", () => {
  it("écrit sous isolation SÉRIALISABLE, et non au niveau par défaut", async () => {
    await POST(vote(["o1"]), ctx);
    expect(h.isolation).toBe("Serializable");
    expect(h.essais).toBe(1);
  });

  it("REJOUE la transaction sur conflit d'écriture, au lieu de perdre le vote", async () => {
    h.jette = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "6",
    });
    const res = await POST(vote(["o1"]), ctx);
    expect(res.status).toBe(200);
    expect(h.essais).toBe(2);
    expect(h.ecrit).toEqual([{ optionId: "o1", userId: "u1" }]);
  });

  // Ceinture : une ligne identique qui subsisterait malgré tout ne doit pas faire échouer le
  // vote. La clé est (option, membre) — un doublon EST le même vote, jamais un conflit réel.
  it("tolère un doublon à la réinsertion", async () => {
    await POST(vote(["o1"]), ctx);
    const args = (client.forumPollVote.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
  });
});

// Chaque vote coûte une lecture, une transaction à deux écritures, la relecture du sondage ET
// UN ÉVÉNEMENT PUSHER — dont le quota est JOURNALIER. Un client qui boucle ne fait pas
// qu'alourdir Neon : il fait taire le temps réel du fil pour tout le club jusqu'au lendemain.
describe("garde-fou de débit", () => {
  /** `n` gestes déjà journalisés pour ce membre, il y a `ilYa` ms. */
  const prerempli = (n: number, ilYa = 0, identifier = "forum-vote:u1") =>
    Array.from({ length: n }, () => ({
      ip: "geste", identifier, createdAt: new Date(Date.now() - ilYa),
    }));

  it("bascule ×60 : un client qui coche/décoche la même case finit en 429", async () => {
    // LE DÉFAUT : la limite comptait les voix ENCORE PRÉSENTES, or chaque vote efface les cases
    // du membre avant de reposer les siennes. Cocher/décocher à l'infini laissait le compteur à
    // une voix au plus — le 429 ne partait jamais, et chaque clic diffusait un événement Pusher.
    for (let i = 0; i < 60; i++) {
      expect((await POST(vote(i % 2 ? [] : ["o1"]), ctx)).status).toBe(200);
    }
    h.diffuse = null;
    h.ecrit = null;
    h.efface = null;
    expect((await POST(vote(["o1"]), ctx)).status).toBe(429);
    expect(h.ecrit).toBeNull();
    expect(h.efface).toBeNull();
    expect(h.diffuse).toBeNull();
  });

  it("laisse passer un usage normal", async () => {
    h.journal = prerempli(59);
    expect((await POST(vote(["o1"]), ctx)).status).toBe(200);
  });

  it("compte les gestes d'UN SEUL membre, sur une fenêtre glissante de 10 min", async () => {
    // Les gestes d'un autre membre, ou plus vieux que la fenêtre, ne comptent pas.
    h.journal = [...prerempli(60, 0, "forum-vote:u2"), ...prerempli(60, 10 * 60_000 + 1000)];
    expect((await POST(vote(["o1"]), ctx)).status).toBe(200);
    // … et les vieux gestes du membre sont purgés au passage ; ceux d'u2 restent.
    expect(h.journal.filter((l) => l.identifier === "forum-vote:u1")).toHaveLength(1);
    expect(h.journal.filter((l) => l.identifier === "forum-vote:u2")).toHaveLength(60);
  });

  it("ne compte pas la réaction du fil dans le compteur du vote", async () => {
    h.journal = prerempli(60, 0, "forum-react:u1");
    expect((await POST(vote(["o1"]), ctx)).status).toBe(200);
  });
});

describe("ce que la route refuse", () => {
  // Sans ce contrôle, un identifiant emprunté à un AUTRE sondage y ajouterait une voix.
  it("refuse une option qui n'appartient pas à ce sondage", async () => {
    const res = await POST(vote(["o1", "ailleurs"]), ctx);
    expect(res.status).toBe(400);
    expect(h.ecrit).toBeNull();
  });

  it("refuse un corps qui n'est pas une liste", async () => {
    expect((await POST(vote("o1"), ctx)).status).toBe(400);
    expect((await POST(vote(null), ctx)).status).toBe(400);
    expect(h.ecrit).toBeNull();
  });

  it("refuse en 409 le vote sur un sondage clos", async () => {
    h.poll = { ...(h.poll as object), closedAt: new Date() };
    const res = await POST(vote(["o1"]), ctx);
    expect(res.status).toBe(409);
    expect(h.ecrit).toBeNull();
  });
});

describe("la diffusion", () => {
  // On diffuse l'ÉTAT COMPLET et non un delta : un vote à choix multiple remplace l'ensemble
  // des cases d'un membre, ce qui ne s'exprime pas simplement comme un delta.
  it("porte le sondage entier, pour que personne ne relise la base", async () => {
    await POST(vote(["o1"]), ctx);
    expect(h.diffuse?.[0]).toBe("poll");
    expect(h.diffuse?.[1].id).toBe("p1");
    expect(h.diffuse?.[1].messageId).toBe("m1");
  });
});

// Clore est la version douce d'effacer : mêmes droits que la suppression d'un message.
describe("PATCH — clore et rouvrir", () => {
  it("laisse l'auteur clore, puis rouvrir", async () => {
    expect((await PATCH(clore(true), ctx)).status).toBe(200);
    expect(h.maj?.closedAt).toBeInstanceOf(Date);
    await PATCH(clore(false), ctx);
    expect(h.maj?.closedAt).toBeNull();
  });

  it("laisse l'ADMIN clore celui d'un autre", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "chef@example.com" };
    h.poll = { ...(h.poll as object), message: { authorId: "u2" } };
    expect((await PATCH(clore(true), ctx)).status).toBe(200);
  });

  // 404 et non 403 : distinguer les deux apprendrait à un curieux quels sondages existent.
  it("répond 404, et non 403, à un tiers", async () => {
    h.session = { userId: "quidam", displayName: "Quidam", email: "quidam@example.com" };
    h.poll = { ...(h.poll as object), message: { authorId: "u2" } };
    expect((await PATCH(clore(true), ctx)).status).toBe(404);
    expect(h.maj).toBeNull();
  });

  it("refuse autre chose qu'un booléen", async () => {
    expect((await PATCH(clore("oui"), ctx)).status).toBe(400);
    expect(h.maj).toBeNull();
  });
});
