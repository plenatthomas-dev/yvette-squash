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
  /** Le contenu du faux Data Cache : clé → valeur, tags, seconde d'expiration. */
  entrees: new Map<string, { valeur: unknown; tags: string[]; expire: number }>(),
  /** Horloge du faux cache, en SECONDES. Seul le TTL la lit. */
  maintenant: 0,
}));

// UN FAUX CACHE QUI CACHE VRAIMENT.
//
// Le mock précédent remplaçait `unstable_cache` par un passe-plat : il ignorait `keyParts`,
// `tags` et `revalidate`. Aucun test n'observait donc un hit, ni le tag posé sur l'entrée, ni
// le TTL — et surtout, SUPPRIMER `liveCached` pour appeler `readLive()` directement n'aurait
// fait échouer aucun test du fichier, « relit la base quand le cache est indisponible »
// compris, qui comptait une lecture dans les deux cas.
//
// Or c'est cette pièce-là qui porte tout le modèle de coût du direct : « la requête lourde est
// mutualisée entre tous les spectateurs », donc bornée par la cadence du marqueur et non par
// l'audience. Une promesse de facture, vérifiée par rien.
//
// Celui-ci mémorise par clé, purge sur le tag, et expire. Il reste minuscule — ce n'est pas le
// Data Cache de Next qu'on teste, c'est l'usage que ce module en fait.
vi.mock("next/cache", () => ({
  unstable_cache:
    (
      fn: () => Promise<unknown>,
      keyParts?: string[],
      opts?: { tags?: string[]; revalidate?: number },
    ) =>
    async () => {
      if (h.cacheEnPanne) throw new Error("Data Cache indisponible");
      const cle = (keyParts ?? []).join("|");
      const e = h.entrees.get(cle);
      if (e && h.maintenant < e.expire) return e.valeur;
      const valeur = await fn();
      h.entrees.set(cle, {
        valeur,
        tags: opts?.tags ?? [],
        expire: h.maintenant + (opts?.revalidate ?? Number.POSITIVE_INFINITY),
      });
      return valeur;
    },
  revalidateTag: vi.fn((tag: string) => {
    if (h.revalidateJette) throw new Error("hors contexte de requête");
    h.tagsInvalides.push(tag);
    for (const [cle, e] of h.entrees) if (e.tags.includes(tag)) h.entrees.delete(cle);
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
  h.entrees.clear();
  h.maintenant = 0;
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

// Ce que promet l'en-tête du module, en toutes lettres : « la requête de rencontres — la plus
// lourde, avec ses jointures sur les matchs et les jeux — est bornée par la CADENCE DU MARQUEUR
// et non par le nombre de spectateurs ». C'est une promesse de facture, et elle se mesure.
describe("getLiveFixtures — le Data Cache, qui porte tout le modèle de coût", () => {
  it("mutualise la requête lourde : dix spectateurs, UNE lecture de base", async () => {
    h.rows = [rencontre()];
    for (let i = 0; i < 10; i++) await getLiveFixtures();
    expect(h.lecturesDb).toBe(1);
  });

  it("pose le tag du direct sur l'entrée, et une écriture du marqueur la purge", async () => {
    h.rows = [rencontre()];
    await getLiveFixtures();
    await getLiveFixtures();
    expect(h.lecturesDb).toBe(1);

    // Un point marqué : le marqueur invalide le tag…
    interclubChanged();
    expect(h.tagsInvalides).toEqual(["interclub-live"]);

    // …et le spectateur suivant retouche la base. Sans le tag sur l'entrée, il aurait servi
    // un score périmé jusqu'à l'expiration.
    await getLiveFixtures();
    expect(h.lecturesDb).toBe(2);
  });

  it("sert la donnée FRAÎCHE après une invalidation, pas l'ancienne", async () => {
    h.rows = [rencontre({ opponent: "Massy" })];
    expect((await getLiveFixtures())[0].opponent).toBe("Massy");

    h.rows = [rencontre({ opponent: "Orsay" })];
    // Tant que rien n'invalide, le cache fait son travail — y compris en cachant le changement.
    expect((await getLiveFixtures())[0].opponent).toBe("Massy");

    interclubChanged();
    expect((await getLiveFixtures())[0].opponent).toBe("Orsay");
  });

  it("expire au bout de 30 s, filet d'une invalidation manquée", async () => {
    h.rows = [rencontre()];
    await getLiveFixtures();

    // 29 s plus tard, toujours le cache : entre deux matchs, on ne relit pas Postgres.
    h.maintenant = 29;
    await getLiveFixtures();
    expect(h.lecturesDb).toBe(1);

    // Au-delà, on relit — une invalidation manquée ne fige donc l'affichage que le temps du TTL.
    h.maintenant = 31;
    await getLiveFixtures();
    expect(h.lecturesDb).toBe(2);
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
