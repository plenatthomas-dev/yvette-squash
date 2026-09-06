import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE CORPUS DE LA RECHERCHE.
//
// Cette route existe pour que le navigateur filtre lui-même : à l'échelle du fil (un club,
// douze mois), c'est moins cher qu'un index trigramme et cela gère les accents, que Postgres
// ne gérerait qu'avec `unaccent`. Les tests verrouillent les trois choses dont dépend cette
// bascule : les mêmes gardes que le reste du fil, la MÊME forme de ligne que le fil (sinon
// l'écran afficherait deux vérités selon la requête qui l'alimente), et l'aveu de troncature.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  /** Les arguments vus par `findMany`, pour prouver le sens du tri et le `+1`. */
  args: null as null | Record<string, unknown>,
  /** Combien de lignes la base rend. Au-delà du plafond, la route doit l'avouer. */
  total: 3,
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ forum: h.forumOn }) }));

/** Une ligne brute telle que `SELECT_MESSAGE` la rend, du plus récent au plus ancien. */
const ligne = (n: number) => ({
  id: `m${n}`,
  body: `message ${n}`,
  authorId: "u1",
  // Décroissant avec `n` : la base rend `desc`, donc `m0` est le plus récent.
  createdAt: new Date(2026, 0, 1, 12, 0, 0, 1000 - n),
  replyToId: null,
  author: { displayName: "Thomas" },
  replyTo: null,
});

vi.mock("@/lib/db", () => ({
  prisma: {
    forumMessage: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.args = args;
        const take = args.take as number;
        return Array.from({ length: Math.min(h.total, take) }, (_, i) => ligne(i));
      }),
    },
  },
}));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.args = null;
  h.total = 3;
});

describe("GET /api/forum/recherche — les gardes", () => {
  it("404 quand la fonction est coupée, avant même de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
    // Le corpus est le fil ENTIER : il ne doit pas partir avant que la session soit établie.
    expect(h.args).toBeNull();
  });
});

describe("GET /api/forum/recherche — le corpus", () => {
  it("rend les messages du plus ancien au plus récent, comme le fil", async () => {
    const data = await (await GET(req())).json();
    expect(data.messages.map((m: { id: string }) => m.id)).toEqual(["m2", "m1", "m0"]);
  });

  // La ligne rendue ici doit être INDISCERNABLE de celle du fil : c'est ce qui permet à l'écran
  // de rendre les résultats avec le même composant de bulle, sans branche de secours.
  it("rend la MÊME forme de ligne que le fil", async () => {
    const data = await (await GET(req())).json();
    expect(data.messages[0]).toEqual({
      id: "m2",
      body: "message 2",
      authorId: "u1",
      authorName: "Thomas",
      createdAt: new Date(2026, 0, 1, 12, 0, 0, 998).toISOString(),
      replyToId: null,
      replyToAuthor: null,
      replyToExcerpt: null,
    });
  });

  // Le coût de cette route est son unique argument face à un `?q=` serveur : une seule requête,
  // et surtout PAS les réactions ni les sondages de deux mille messages.
  it("ne charge ni réactions ni sondages — la recherche est une vue de lecture", async () => {
    const data = await (await GET(req())).json();
    expect(data.reactions).toBeUndefined();
    expect(data.polls).toBeUndefined();
  });

  it("demande la tranche la plus RÉCENTE, avec une ligne de marge pour savoir qu'il déborde", async () => {
    await GET(req());
    expect(h.args).toMatchObject({ orderBy: { createdAt: "desc" }, take: 2001 });
  });
});

// UNE RECHERCHE QUI NE COUVRE QU'UNE PARTIE DU FIL SANS LE DIRE EST PIRE QUE PAS DE RECHERCHE :
// on conclut « personne n'en a jamais parlé » d'un silence qui n'est que le plafond.
describe("GET /api/forum/recherche — la troncature s'avoue", () => {
  it("ne se déclare pas tronqué tant que le fil tient sous le plafond", async () => {
    const data = await (await GET(req())).json();
    expect(data.tronque).toBe(false);
    expect(data.messages).toHaveLength(3);
  });

  it("avoue la troncature, et rend exactement le plafond — pas la ligne de marge", async () => {
    h.total = 5000;
    const data = await (await GET(req())).json();
    expect(data.tronque).toBe(true);
    expect(data.messages).toHaveLength(2000);
  });

  it("garde les plus RÉCENTS quand il tronque, jamais les plus anciens", async () => {
    h.total = 5000;
    const data = await (await GET(req())).json();
    // `m0` est le plus récent de la base : il doit survivre à la coupe et fermer la liste.
    expect(data.messages.at(-1).id).toBe("m0");
    expect(data.messages[0].id).toBe("m1999");
  });
});
