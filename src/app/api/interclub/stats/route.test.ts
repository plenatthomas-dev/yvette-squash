import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE PALMARÈS — ce que la route lit, et ce qu'elle refuse de charger.
//
// Deux propriétés tiennent ici et nulle part ailleurs :
//   * elle FILTRE en base sur `status: "done"`, plutôt que de tout charger pour laisser
//     `playerStats` refiltrer : la requête joint le jeu par jeu de toutes les soirées, et
//     charger les matchs en cours pour les jeter ensuite se paierait à chaque ouverture ;
//   * elle est réservée aux membres, comme le reste de l'appli — on y lit des noms de joueurs.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  matches: [] as Array<Record<string, unknown>>,
  seasons: [] as Array<{ season: string | null }>,
  lastWhere: null as unknown,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubMatch: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        h.lastWhere = args.where;
        return h.matches;
      }),
    },
    interclub: { findMany: vi.fn(async () => h.seasons) },
  },
}));

import { GET } from "./route";

const req = (qs = "") =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams(qs) },
  }) as unknown as NextRequest;

/** Un simple gagné 3-0, jeu par jeu compris. */
const simple = (over: Record<string, unknown> = {}) => ({
  status: "done",
  gamesHome: 3,
  gamesAway: 0,
  homeUserId: "u1",
  homeGuestId: null,
  homeDisplayName: "Thomas",
  games: [
    { pointsHome: 11, pointsAway: 5 },
    { pointsHome: 11, pointsAway: 6 },
    { pointsHome: 11, pointsAway: 7 },
  ],
  ...over,
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.matches = [];
  h.seasons = [];
  h.lastWhere = null;
});

describe("GET /api/interclub/stats", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("rend le palmarès de chaque joueur", async () => {
    h.matches = [
      simple(),
      simple({ gamesHome: 1, gamesAway: 3 }),
      simple({ homeUserId: "u2", homeDisplayName: "Léa" }),
    ];
    const body = await (await GET(req())).json();
    expect(body.rows).toHaveLength(2);
    // Léa passe devant : une victoire sur une, contre une sur deux.
    expect(body.rows[0]).toMatchObject({ name: "Léa", played: 1, won: 1, winRate: 1 });
    expect(body.rows[1]).toMatchObject({ name: "Thomas", played: 2, won: 1 });
    expect(body.rows[1].winRate).toBeCloseTo(0.5);
  });

  it("NE CHARGE QUE les matchs terminés", async () => {
    await GET(req());
    expect(h.lastWhere).toMatchObject({ status: "done" });
  });

  it("filtre sur l'équipe quand on la demande, et sur RIEN d'autre", async () => {
    await GET(req("teamId=t1"));
    expect(h.lastWhere).toEqual({ status: "done", interclub: { teamId: "t1" } });
  });

  it("filtre sur la saison quand on la demande, et sur RIEN d'autre", async () => {
    await GET(req("season=2025-2026"));
    expect(h.lastWhere).toEqual({ status: "done", interclub: { season: "2025-2026" } });
  });

  it("sans filtre, ne restreint NI l'équipe NI la saison", async () => {
    // Un joueur qui dépanne en équipe 2 doit retrouver ses matchs quelque part.
    //
    // `toEqual` et non `toMatchObject` : celui-ci ne vérifiait que « `interclub` est un objet »,
    // et passait donc à l'identique si la route avait posé un `teamId` en dur — c'est-à-dire
    // dans le cas exact que ce test prétend interdire.
    await GET(req());
    expect(h.lastWhere).toEqual({ status: "done", interclub: {} });
  });

  it("rend les saisons saisies, pour alimenter le filtre", async () => {
    h.seasons = [{ season: "2025-2026" }, { season: null }, { season: "2024-2025" }];
    const body = await (await GET(req())).json();
    // La saison nulle disparaît : proposer un filtre vide ne filtrerait rien.
    expect(body.seasons).toEqual(["2025-2026", "2024-2025"]);
  });

  it("rend une liste vide sans rien inventer", async () => {
    const body = await (await GET(req())).json();
    expect(body).toEqual({ rows: [], seasons: [] });
  });
});
