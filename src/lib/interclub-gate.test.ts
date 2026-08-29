import { describe, it, expect, beforeEach, vi } from "vitest";

// Ce module promet trois choses en commentaire, et ce sont elles qu'on vérifie ici :
//   1. le direct est servi par le Data Cache, mais une panne de cache DÉGRADE le coût, jamais
//      l'exactitude — on relit alors Postgres ;
//   2. une invalidation impossible ne fait pas échouer l'écriture du score qui l'a déclenchée ;
//   3. le statut affiché est DÉDUIT des matchs, pas la colonne stockée (qui peut être en
//      retard quand deux marqueurs écrivent en même temps).

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  dernierFindMany: null as null | Record<string, unknown>,
  lecturesDb: 0,
  cacheEnPanne: false,
  tagsInvalides: [] as string[],
  revalidateJette: false,
}));

vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>) =>
    async () => {
      if (h.cacheEnPanne) throw new Error("Data Cache indisponible");
      return fn();
    },
  revalidateTag: vi.fn((tag: string) => {
    if (h.revalidateJette) throw new Error("hors contexte de requête");
    h.tagsInvalides.push(tag);
  }),
}));

vi.mock("./db", () => ({
  prisma: {
    interclub: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.lecturesDb += 1;
        h.dernierFindMany = args;
        return h.rows;
      }),
    },
  },
}));

import { getLiveFixtures, interclubChanged, todayISO } from "./interclub-gate";

/** Une rencontre telle que Prisma la rend, réduite à ce que le module lit. */
function rencontre(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    date: "2026-03-12",
    teamId: "t1",
    team: { id: "t1", name: "Équipe 1" },
    opponent: "Massy",
    home: true,
    division: "D2",
    status: "scheduled",
    matchCount: 4,
    matches: [],
    ...over,
  };
}

function match(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    order: 1,
    homeDisplayName: "Tom",
    awayName: "Luc",
    homeColor: "rouge",
    awayColor: "bleu",
    status: "pending",
    gamesHome: null,
    gamesAway: null,
    liveJson: null,
    games: [],
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.dernierFindMany = null;
  h.lecturesDb = 0;
  h.cacheEnPanne = false;
  h.tagsInvalides = [];
  h.revalidateJette = false;
});

describe("todayISO", () => {
  it("rend la date MURALE du club, pas celle d'UTC", () => {
    // 31 décembre 22 h UTC = 31 décembre 23 h à Paris : même jour. Mais 23 h UTC = 1er janvier
    // à Paris — c'est ce décalage qui ferait disparaître une rencontre de fin de soirée.
    expect(todayISO(new Date("2025-12-31T22:00:00Z"))).toBe("2025-12-31");
    expect(todayISO(new Date("2025-12-31T23:30:00Z"))).toBe("2026-01-01");
  });
});

describe("getLiveFixtures — bornes de la requête", () => {
  it("borne le nombre de rencontres et pose un plancher de date", async () => {
    await getLiveFixtures();
    const args = h.dernierFindMany as Record<string, unknown>;
    expect(args.take).toBe(6);
    const where = args.where as { date: { gte: string }; OR: unknown[] };
    // Le plancher est deux jours en arrière : une soirée qui déborde après minuit reste
    // visible, une rencontre oubliée en « live » depuis trois semaines ne l'est plus.
    expect(where.date.gte < todayISO()).toBe(true);
    expect(where.OR).toHaveLength(2);
  });
});

describe("getLiveFixtures — mise en forme", () => {
  it("déduit le statut des matchs au lieu de recopier la colonne stockée", async () => {
    h.rows = [
      rencontre({
        status: "scheduled", // en retard : deux marqueurs ont écrit en parallèle
        matches: [
          match({ id: "m1", order: 1, status: "done", gamesHome: 3, gamesAway: 0 }),
          match({ id: "m2", order: 2, status: "live" }),
        ],
      }),
    ];
    const [f] = await getLiveFixtures();
    expect(f.status).toBe("live");
    expect(f.score).toEqual({ home: 1, away: 0 });
  });

  it("ne publie du direct que le score et le serveur — jamais le carré de service", async () => {
    h.rows = [
      rencontre({
        matches: [
          match({
            status: "live",
            liveJson: JSON.stringify({
              current: { home: 7, away: 4 },
              serving: "home",
              servingBox: "right",
              awaitingServeBox: false,
            }),
          }),
        ],
      }),
    ];
    const [f] = await getLiveFixtures();
    expect(f.matches[0].live).toEqual({ current: { home: 7, away: 4 }, serving: "home" });
    expect(f.matches[0].live).not.toHaveProperty("servingBox");
  });

  it("ignore l'instantané d'un match qui n'est pas en cours", async () => {
    // Un `liveJson` résiduel sur un match terminé afficherait un score figé à côté du résultat.
    h.rows = [
      rencontre({
        matches: [
          match({
            status: "done",
            gamesHome: 3,
            gamesAway: 1,
            liveJson: JSON.stringify({ current: { home: 5, away: 2 }, serving: "away" }),
          }),
        ],
      }),
    ];
    const [f] = await getLiveFixtures();
    expect(f.matches[0].live).toBeNull();
  });
});

describe("getLiveFixtures — panne de cache", () => {
  it("relit la base quand le cache est indisponible, sans jamais échouer", async () => {
    h.rows = [rencontre()];
    h.cacheEnPanne = true;
    const fixtures = await getLiveFixtures();
    expect(fixtures).toHaveLength(1);
    expect(h.lecturesDb).toBe(1); // dégradé en coût…
    expect(fixtures[0].opponent).toBe("Massy"); // …jamais en exactitude
  });
});

describe("interclubChanged", () => {
  it("invalide le tag du direct", () => {
    interclubChanged();
    expect(h.tagsInvalides).toEqual(["interclub-live"]);
  });

  it("ne jette pas quand l'invalidation échoue : un score ne se perd pas pour un cache", () => {
    h.revalidateJette = true;
    expect(() => interclubChanged()).not.toThrow();
  });
});
