import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE PALMARÈS — ce que la route lit, et d'où.
//
// Trois propriétés tiennent ici et nulle part ailleurs :
//   * elle compte sur les FEUILLES OFFICIELLES rangées en base, jamais sur nos relevés : une
//     soirée non marquée dans l'appli compte quand même ;
//   * une rencontre jouée SANS feuille exploitable est comptée à part (`pending`), pour que
//     l'écran dise qu'il en manque ;
//   * elle est réservée aux membres, comme le reste de l'appli — on y lit des noms de joueurs.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  fixtures: [] as Array<Record<string, unknown>>,
  seasons: [] as Array<{ season: string | null }>,
  users: [] as Array<Record<string, unknown>>,
  guests: [] as Array<Record<string, unknown>>,
  fixturesWhere: null as unknown,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/interclub-roster-db", () => ({ loadRosters: vi.fn(async () => new Map()) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: {
      findMany: vi.fn(async (args: { where: unknown; select: Record<string, unknown> }) => {
        if ("season" in args.select) return h.seasons;
        h.fixturesWhere = args.where;
        return h.fixtures;
      }),
    },
    user: { findMany: vi.fn(async () => h.users) },
    interclubGuest: { findMany: vi.fn(async () => h.guests) },
    interclubTeam: { findMany: vi.fn(async () => []) },
  },
}));

import { GET } from "./route";

const req = (qs = "") =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams(qs) },
  }) as unknown as NextRequest;

const joueur = (name: string) => ({ name, regiid: null, clt: null, rang: null, rangM: null });

/** Une rencontre et sa feuille : un simple par nom donné, gagné par nous (côté A) si `gagne`. */
const rencontre = (simples: Array<[string, boolean]>, side: string | null = "A") => ({
  snSheetJson: JSON.stringify({
    snTieId: "1",
    codeA: null,
    codeB: null,
    lines: simples.map(([nom, gagne], i) => ({
      label: `Homme ${i + 1}`,
      a: joueur(nom),
      b: joueur("ADVERSAIRE X"),
      score: null,
      winner: gagne ? "A" : "B",
      gamesA: gagne ? 3 : 0,
      gamesB: gagne ? 0 : 3,
      pointsA: null,
      pointsB: null,
    })),
  }),
  snSheetSide: side,
  snSheetAt: new Date("2026-10-15T20:00:00Z"),
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.fixtures = [];
  h.seasons = [];
  h.users = [];
  h.guests = [];
  h.fixturesWhere = null;
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

  it("rend le palmarès lu sur les feuilles, sous le nom de l'appli quand on sait relier", async () => {
    h.users = [
      { id: "u1", displayName: "Thomas Plenat", nickname: "Tom", snLicence: null, squashnetGivenName: null, squashnetFamilyName: null },
    ];
    h.fixtures = [
      rencontre([["PLENAT THOMAS", true], ["MARTIN LEA", true]]),
      rencontre([["PLENAT THOMAS", false]]),
    ];
    const body = await (await GET(req())).json();
    expect(body.rows).toHaveLength(2);
    // Léa passe devant : une victoire sur une, contre une sur deux.
    expect(body.rows[0]).toMatchObject({ name: "Martin Lea", played: 1, won: 1, isMember: false });
    expect(body.rows[1]).toMatchObject({ key: "u:u1", name: "Tom", played: 2, won: 1, isMember: true });
    expect(body.sheetsAt).toBe("2026-10-15T20:00:00.000Z");
  });

  it("compte À PART les rencontres jouées sans feuille, ou sans notre côté reconnu", async () => {
    h.fixtures = [
      rencontre([["PLENAT THOMAS", true]]),
      { snSheetJson: null, snSheetSide: null, snSheetAt: null },
      rencontre([["PLENAT THOMAS", true]], null),
    ];
    const body = await (await GET(req())).json();
    expect(body.pending).toBe(2);
    expect(body.rows).toEqual([expect.objectContaining({ played: 1 })]);
  });

  it("ne lit que les rencontres PASSÉES et ayant eu lieu", async () => {
    await GET(req());
    expect(h.fixturesWhere).toMatchObject({
      date: { lt: expect.any(String) },
      OR: [{ dateConfirmed: true }, { status: { not: "scheduled" } }],
    });
    expect(h.fixturesWhere).not.toHaveProperty("teamId");
    expect(h.fixturesWhere).not.toHaveProperty("season");
  });

  it("filtre sur l'équipe et la saison quand on les demande", async () => {
    await GET(req("teamId=t1&season=2025-2026"));
    expect(h.fixturesWhere).toMatchObject({ teamId: "t1", season: "2025-2026" });
  });

  it("rend les saisons saisies, pour alimenter le filtre", async () => {
    h.seasons = [{ season: "2025-2026" }, { season: null }, { season: "2024-2025" }];
    const body = await (await GET(req())).json();
    // La saison nulle disparaît : proposer un filtre vide ne filtrerait rien.
    expect(body.seasons).toEqual(["2025-2026", "2024-2025"]);
  });

  it("rend une liste vide sans rien inventer", async () => {
    const body = await (await GET(req())).json();
    expect(body).toEqual({ rows: [], seasons: [], pending: 0, sheetsAt: null });
  });
});
