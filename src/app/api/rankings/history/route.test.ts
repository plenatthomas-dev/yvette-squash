import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  flags: { ranking: true, rankingHistory: true, interclub: true },
  session: null as null | { userId: string },
  /** Périodes rendues par le `groupBy(["month"])`, les plus récentes d'abord. */
  months: [] as Array<{ month: string }>,
  points: [] as Array<Record<string, unknown>>,
  groupBy: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: true,
    delegation: false,
    tournament: false,
    ranking: h.flags.ranking,
    rankingHistory: h.flags.rankingHistory,
    interclub: h.flags.interclub,
  }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    squashnetRankingPoint: {
      // Deux appels DISTINCTS, et c'est le sujet d'un test : les MOIS passent par un vrai
      // `GROUP BY` (le `distinct` de Prisma se ferait en mémoire, après le `take`), les POINTS
      // par un `findMany` borné à ces mois.
      groupBy: (...a: unknown[]) => h.groupBy(...a),
      findMany: (...a: unknown[]) => h.findMany(...a),
    },
  },
}));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.flags = { ranking: true, rankingHistory: true, interclub: true };
  h.session = { userId: "u1" };
  h.months = [];
  h.points = [];
  // La route fait DEUX requêtes sur la même table : les mois (groupBy), puis les points.
  h.groupBy.mockReset().mockImplementation(async () => h.months);
  h.findMany.mockReset().mockImplementation(async () => h.points);
});

/** Un point porté par un MEMBRE. */
function pointMembre(month: string, over: Record<string, unknown> = {}) {
  return {
    month,
    clt: "5A",
    rang: 3184,
    rangM: 3603,
    mean: 3832.17,
    user: { id: "u1", displayName: "Jean Dupont", nickname: null, team: { name: "Équipe 1" } },
    guest: null,
    ...over,
  };
}

describe("GET /api/rankings/history", () => {
  it("404 si la fonction classement est coupée", async () => {
    h.flags.ranking = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("404 si la COURBE est coupée, classement fédéral ouvert par ailleurs", async () => {
    // Les deux flags sont exigés séparément, et « et » n'est pas « ou » : `ranking` est le seul
    // ouvert en production, si bien qu'adosser la courbe à lui l'aurait mise devant les membres
    // le jour de son merge. C'est ce couplage-là que ce test interdit de rétablir par mégarde.
    h.flags.rankingHistory = false;
    expect(h.flags.ranking).toBe(true);
    expect((await GET(req())).status).toBe(404);
  });

  it("401 sans session", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("historique vide → charge utile vide, sans deuxième requête", async () => {
    const res = await GET(req());
    expect(await res.json()).toEqual({ months: [], series: [] });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  // LE BOGUE QUI COUPAIT LA COURBE À UNE DATE INEXPLIQUÉE. `findMany({ distinct, take })` ne
  // fait pas un `SELECT DISTINCT` : Prisma dédoublonne EN MÉMOIRE, après le `take`. « Les 36
  // dernières périodes » demandait donc « les 36 dernières LIGNES », soit — à quarante joueurs
  // par mois — un seul mois. Le nombre de mois affichés dépendait du nombre de joueurs.
  it("compte les mois par un GROUP BY, jamais par un `distinct` paginé", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02")];
    await GET(req());
    expect(h.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["month"] }));
    // Et la borne de profondeur porte bien sur des MOIS, donc sur le groupBy.
    const args = h.groupBy.mock.calls[0][0] as { take: number };
    expect(args.take).toBeGreaterThanOrEqual(24);
    // Le second appel ne redemande jamais un dédoublonnage : il est borné aux mois retenus.
    expect(h.findMany.mock.calls[0][0]).not.toHaveProperty("distinct");
  });

  it("rend les mois dans l'ORDRE CHRONOLOGIQUE, celui de la courbe", async () => {
    // La base les rend décroissants (pour couper aux plus récents) ; la courbe les lit dans
    // l'autre sens. Servir l'ordre de la base tracerait le temps à l'envers.
    h.months = [{ month: "2026-03-02" }, { month: "2026-02-02" }];
    h.points = [pointMembre("2026-02-02"), pointMembre("2026-03-02")];
    const { months } = await (await GET(req())).json();
    expect(months).toEqual(["2026-02-02", "2026-03-02"]);
  });

  it("regroupe les points par joueur, série chronologique", async () => {
    h.months = [{ month: "2026-03-02" }, { month: "2026-02-02" }];
    h.points = [pointMembre("2026-02-02", { mean: 1000 }), pointMembre("2026-03-02", { mean: 1100 })];
    const { series } = await (await GET(req())).json();
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ id: "u1", kind: "member", name: "Jean Dupont", team: "Équipe 1" });
    expect(series[0].points.map((p: { mean: number }) => p.mean)).toEqual([1000, 1100]);
  });

  it("affiche le pseudo quand il existe, comme partout ailleurs", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [
      pointMembre("2026-03-02", {
        user: { id: "u1", displayName: "Jean Dupont", nickname: "Jeannot", team: null },
      }),
    ];
    const { series } = await (await GET(req())).json();
    expect(series[0]).toMatchObject({ name: "Jeannot", team: null });
  });

  it("mêle les joueurs SANS COMPTE, sous un identifiant préfixé", async () => {
    // Préfixé comme dans l'annuaire : rien ne garantit qu'un identifiant d'invité ne ressemble
    // pas à celui d'un compte, et les deux partagent une liste — donc des clés React.
    h.months = [{ month: "2026-03-02" }];
    h.points = [
      pointMembre("2026-03-02"),
      pointMembre("2026-03-02", {
        user: null,
        guest: { id: "g1", name: "Alain Hors-Appli", team: { name: "Équipe 2" } },
      }),
    ];
    const { series } = await (await GET(req())).json();
    // Tri alphabétique sur le nom : « Alain » avant « Jean ».
    expect(series.map((s: { id: string; kind: string }) => [s.id, s.kind])).toEqual([
      ["guest:g1", "guest"],
      ["u1", "member"],
    ]);
  });

  it("n'expose NI licence NI club rapproché : ce sont des données de traçabilité interne", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02")];
    const { series } = await (await GET(req())).json();
    expect(Object.keys(series[0].points[0]).sort()).toEqual([
      "clt",
      "mean",
      "month",
      "rang",
      "rangM",
    ]);
  });

  it("interclub coupé → aucune équipe n'est demandée, ni rendue", async () => {
    h.flags.interclub = false;
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02", { user: { id: "u1", displayName: "Jean Dupont", nickname: null } })];
    const { series } = await (await GET(req())).json();
    expect(series[0].team).toBeNull();
    // Même garde que l'annuaire : le flag à 0 doit rendre les équipes aussi invisibles que
    // l'onglet qui les sert — la jointure elle-même est retirée de la requête.
    const args = h.findMany.mock.calls[0][0] as { select: { user: { select: Record<string, unknown> } } };
    expect(args.select.user.select.team).toBe(false);
  });

  // ── QUI FIGURE SUR LA COURBE ────────────────────────────────────────────────────────────
  // La visibilité se joue dans le `where`, pas dans le rendu : ces essais lisent donc les
  // arguments passés à Prisma. Un test qui n'observerait que la charge utile serait satisfait
  // par un mock complaisant, et c'est exactement ce qui a laissé passer la fuite.

  const membreVisible = { user: { is: { OR: [{ listed: true }, { teamId: { not: null } }] } } };

  it("ne lit que les membres opt-in ou alignés — l'opt-out d'annuaire masque aussi la courbe", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02")];
    await GET(req());
    const where = (h.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({
      month: { in: ["2026-03-02"] },
      OR: [membreVisible, { guest: { isNot: null } }],
    });
  });

  it("applique le MÊME filtre au relevé des mois, sans quoi une colonne resterait vide", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02")];
    await GET(req());
    const where = (h.groupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ OR: [membreVisible, { guest: { isNot: null } }] });
  });

  it("interclub coupé → aucun joueur sans compte n'est LU, pas seulement son équipe", async () => {
    h.flags.interclub = false;
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02")];
    await GET(req());
    // Même garde que `/api/directory`, qui fait `interclub ? allTeamGuests() : []` : plus de
    // branche `guest` du tout, donc aucun invité ne peut ressortir.
    const where = (h.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ month: { in: ["2026-03-02"] }, ...membreVisible });
    expect(JSON.stringify(where)).not.toContain("guest");
  });

  it("ignore une ligne sans sujet plutôt que de lever à l'affichage", async () => {
    h.months = [{ month: "2026-03-02" }];
    h.points = [pointMembre("2026-03-02", { user: null, guest: null })];
    const { series } = await (await GET(req())).json();
    expect(series).toEqual([]);
  });
});
