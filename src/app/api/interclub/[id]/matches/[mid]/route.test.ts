import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  match: null as null | Record<string, unknown>,
  siblings: [] as Array<Record<string, unknown>>,
  user: null as null | Record<string, unknown>,
  admin: false,
  // Ce que la transaction a réellement écrit.
  updated: null as null | Record<string, unknown>,
  createdGames: null as null | Array<Record<string, unknown>>,
  deletedGames: 0,
  fixtureStatus: null as null | string,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/admin", () => ({ isAdminEmail: vi.fn(() => h.admin) }));
vi.mock("@/lib/db", () => {
  const tx = {
    interclubMatch: {
      findUnique: vi.fn(async () => h.match),
      findMany: vi.fn(async () => h.siblings),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return {};
      }),
    },
    interclubGame: {
      deleteMany: vi.fn(async () => {
        h.deletedGames += 1;
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        h.createdGames = args.data;
        return { count: args.data.length };
      }),
    },
    interclub: {
      update: vi.fn(async (args: { data: { status: string } }) => {
        h.fixtureStatus = args.data.status;
        return {};
      }),
    },
    user: { findUnique: vi.fn(async () => h.user) },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      user: { findUnique: vi.fn(async () => h.user) },
    },
  };
});

import { PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "f1", mid: "m1" }) };
const patch = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

/** Un match vierge d'une rencontre au meilleur des 5. */
const freshMatch = () => ({
  id: "m1",
  interclubId: "f1",
  homeUserId: "u9",
  scorerId: null,
  gamesHome: null,
  gamesAway: null,
  interclub: { id: "f1", bestOf: 5, matchCount: 4, createdById: "u1" },
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.match = freshMatch();
  h.siblings = [{ gamesHome: null, status: "pending" }];
  h.user = { email: "someone@example.com" };
  h.admin = false;
  h.updated = null;
  h.createdGames = null;
  h.deletedGames = 0;
  h.fixtureStatus = null;
});

describe("PATCH /api/interclub/{id}/matches/{mid}", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PATCH(patch({}), ctx)).status).toBe(401);
  });

  it("404 si le match est introuvable", async () => {
    h.match = null;
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("404 si le match appartient à une autre rencontre", async () => {
    h.match = { ...freshMatch(), interclubId: "AUTRE" };
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("enregistre un 3-0 et clôt le match", async () => {
    const res = await PATCH(
      patch({
        games: [
          { home: 11, away: 5 },
          { home: 11, away: 8 },
          { home: 11, away: 9 },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(h.updated).toMatchObject({ gamesHome: 3, gamesAway: 0, status: "done" });
    expect(h.createdGames).toHaveLength(3);
    expect(h.createdGames?.[0]).toMatchObject({ number: 1, pointsHome: 11, pointsAway: 5 });
  });

  it("libère la prise de marquage quand le match est fini", async () => {
    await PATCH(
      patch({ games: [{ home: 11, away: 1 }, { home: 11, away: 2 }, { home: 11, away: 3 }] }),
      ctx,
    );
    expect(h.updated).toMatchObject({ scorerClaimedAt: null, liveJson: null });
  });

  it("remplace intégralement les jeux au lieu de les empiler", async () => {
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.deletedGames).toBe(1);
    expect(h.createdGames).toHaveLength(1);
  });

  it("un match mené 1-0 reste en cours, pas terminé", async () => {
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.updated).toMatchObject({ status: "live" });
  });

  it("une liste de jeux vide remet le match à zéro", async () => {
    await PATCH(patch({ games: [] }), ctx);
    expect(h.updated).toMatchObject({ gamesHome: null, gamesAway: null, status: "pending" });
    expect(h.createdGames).toBeNull();
  });

  it("refuse un score impossible pour le format (4e jeu après un 3-0)", async () => {
    const res = await PATCH(
      patch({
        games: [
          { home: 11, away: 5 },
          { home: 11, away: 8 },
          { home: 11, away: 9 },
          { home: 11, away: 4 },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("refuse un jeu non terminé", async () => {
    const res = await PATCH(patch({ games: [{ home: 7, away: 4 }] }), ctx);
    expect(res.status).toBe(400);
  });

  it("refuse une couleur hors palette", async () => {
    expect((await PATCH(patch({ homeColor: "turquoise" }), ctx)).status).toBe(400);
  });

  it("recale le statut de la rencontre dans la même transaction", async () => {
    h.siblings = [
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
    ];
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.fixtureStatus).toBe("done");
  });

  it("409 si le score est déjà saisi et qu'on n'a rien à voir avec ce match", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "intrus" };
    const res = await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(res.status).toBe(409);
  });

  it("le créateur de la rencontre peut corriger un score déjà saisi", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "u1" }; // createdById
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("le joueur concerné peut corriger son propre score", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "u7" };
    h.session = { userId: "u7" };
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("un admin peut corriger un score déjà saisi", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "intrus" };
    h.admin = true;
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("rattacher un membre fige son nom d'affichage", async () => {
    h.user = { id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé" };
    await PATCH(patch({ homeUserId: "u9" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Jéjé" });
  });

  it("refuse de rattacher un membre inconnu", async () => {
    h.user = null;
    expect((await PATCH(patch({ homeUserId: "fantome" }), ctx)).status).toBe(400);
  });

  it("nomme un remplaçant hors appli tout en détachant le membre précédent", async () => {
    await PATCH(patch({ homeUserId: null, homeDisplayName: "Jean-Mi" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Jean-Mi" });
    expect(h.updated?.homeUser).toEqual({ disconnect: true });
  });

  it("le nom d'un membre rattaché prime sur un nom libre envoyé en même temps", async () => {
    h.user = { id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé" };
    await PATCH(patch({ homeUserId: "u9", homeDisplayName: "Truc" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Jéjé" });
  });

  it("refuse un score impossible que « 11 points et 2 d'écart » laisserait passer", async () => {
    // 12-0 satisfait la règle naïve mais n'a pas pu exister : au-delà de 11 on ne marque
    // que pour prendre 2 points d'écart.
    expect((await PATCH(patch({ games: [{ home: 12, away: 0 }] }), ctx)).status).toBe(400);
  });
});
