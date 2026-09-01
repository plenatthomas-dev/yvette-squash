import { describe, it, expect, beforeEach, vi } from "vitest";

// La règle du club vit dans ce module : « seuls les joueurs de l'équipe qui dispute la
// rencontre peuvent être alignés, et un joueur ne dispute qu'un simple ». Elle n'était jusqu'ici
// éprouvée qu'à travers les tests de routes ; ici on la vérifie à la source.

const h = vi.hoisted(() => ({
  membres: [] as Array<Record<string, unknown>>,
  invites: [] as Array<Record<string, unknown>>,
  dernierWhereUser: null as null | Record<string, unknown>,
}));

vi.mock("./db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.dernierWhereUser = args.where;
        return h.membres;
      }),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.invites),
    },
  },
}));

import {
  findAlignmentClash,
  findOrderConflict,
  resolveHomePick,
  resolveHomePicks,
  teamRoster,
} from "./interclub-roster";

/** Faux client Prisma pour `resolveHomePick` : seules deux lectures par id sont utilisées. */
function db(
  users: Record<string, unknown> = {},
  guests: Record<string, unknown> = {},
): Parameters<typeof resolveHomePick>[0] {
  return {
    user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null },
    interclubGuest: {
      findUnique: async ({ where }: { where: { id: string } }) => guests[where.id] ?? null,
    },
  } as never;
}

const membre = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  displayName: "Thomas Plenat",
  nickname: null,
  teamId: "t1",
  disabledAt: null,
  interclubCltOverride: null,
  squashnetRanking: null,
  ...over,
});

beforeEach(() => {
  h.membres = [];
  h.invites = [];
  h.dernierWhereUser = null;
});

describe("teamRoster", () => {
  it("mêle membres et invités, triés par nom sans tenir compte des accents", async () => {
    h.membres = [
      { id: "u1", displayName: "Zoé", nickname: null },
      { id: "u2", displayName: "Bernard", nickname: "Bébert" },
    ];
    h.invites = [{ id: "g1", name: "Émile" }];

    const roster = await teamRoster("t1");
    expect(roster.map((r) => r.name)).toEqual(["Bébert", "Émile", "Zoé"]);
    expect(roster.map((r) => r.kind)).toEqual(["member", "guest", "member"]);
  });

  it("préfère le pseudo au nom, quand il y en a un", async () => {
    h.membres = [{ id: "u1", displayName: "Thomas Plenat", nickname: "Tom" }];
    expect((await teamRoster("t1"))[0].name).toBe("Tom");
  });

  it("exclut les comptes désactivés : ils ne jouent plus", async () => {
    await teamRoster("t1");
    expect(h.dernierWhereUser).toEqual({ teamId: "t1", disabledAt: null });
  });

  it("ne filtre PAS sur l'opt-out d'annuaire : se retirer du trombinoscope n'est pas quitter son équipe", async () => {
    await teamRoster("t1");
    expect(h.dernierWhereUser).not.toHaveProperty("listed");
  });

  it("classement d'un membre : la correction admin l'emporte sur le rapprochement squashnet", async () => {
    h.membres = [
      membre({ id: "u1", displayName: "Zoé", interclubCltOverride: "5B", squashnetRanking: { clt: "3A" } }),
    ];
    expect((await teamRoster("t1"))[0].clt).toBe("5B");
  });

  it("classement d'un membre : à défaut de correction, le rapprochement squashnet", async () => {
    h.membres = [membre({ id: "u1", displayName: "Zoé", squashnetRanking: { clt: "3A" } })];
    expect((await teamRoster("t1"))[0].clt).toBe("3A");
  });

  it("classement d'un membre : `null` si ni correction ni rapprochement", async () => {
    h.membres = [membre({ id: "u1", displayName: "Zoé" })];
    expect((await teamRoster("t1"))[0].clt).toBeNull();
  });

  it("classement d'un invité : celui saisi par l'admin", async () => {
    h.invites = [{ id: "g1", name: "Émile", clt: "4D" } as never];
    expect((await teamRoster("t1"))[0].clt).toBe("4D");
  });
});

describe("resolveHomePick", () => {
  it("accepte un membre de l'équipe et fige son nom d'affichage", async () => {
    const r = await resolveHomePick(
      db({ u1: membre({ nickname: "Tom", squashnetRanking: { clt: "5A" } }) }),
      "t1",
      { userId: "u1" },
    );
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: "u1", homeGuestId: null, homeDisplayName: "Tom", clt: "5A" },
    });
  });

  it("refuse un membre sans classement connu — il ne peut disputer AUCUN simple, pas même le seul désigné", async () => {
    const r = await resolveHomePick(db({ u1: membre({ nickname: "Tom" }) }), "t1", { userId: "u1" });
    expect(r).toEqual({
      ok: false,
      error: "Tom : classement inconnu — attribue-lui un classement avant de le désigner",
    });
  });

  it("refuse un membre d'une AUTRE équipe, même avec un identifiant valide", async () => {
    const r = await resolveHomePick(db({ u1: membre({ teamId: "t2" }) }), "t1", { userId: "u1" });
    expect(r.ok).toBe(false);
  });

  it("refuse un compte désactivé", async () => {
    const r = await resolveHomePick(db({ u1: membre({ disabledAt: new Date() }) }), "t1", {
      userId: "u1",
    });
    expect(r.ok).toBe(false);
  });

  it("refuse un identifiant inconnu", async () => {
    const r = await resolveHomePick(db(), "t1", { userId: "fantôme" });
    expect(r).toEqual({ ok: false, error: "Membre inconnu" });
  });

  it("accepte un invité de l'équipe, et refuse celui d'une autre", async () => {
    const guests = {
      g1: { id: "g1", name: "Marc", teamId: "t1", clt: "4D" },
      g2: { id: "g2", name: "Luc", teamId: "t2", clt: "4D" },
    };
    const ok = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(ok).toEqual({
      ok: true,
      value: { homeUserId: null, homeGuestId: "g1", homeDisplayName: "Marc", clt: "4D" },
    });
    expect((await resolveHomePick(db({}, guests), "t1", { guestId: "g2" })).ok).toBe(false);
  });

  it("refuse un invité sans classement connu", async () => {
    const guests = { g1: { id: "g1", name: "Marc", teamId: "t1", clt: null } };
    const r = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(r).toEqual({
      ok: false,
      error: "Marc : classement inconnu — attribue-lui un classement avant de le désigner",
    });
  });

  it("refuse de désigner à la fois un membre et un invité", async () => {
    const r = await resolveHomePick(db(), "t1", { userId: "u1", guestId: "g1" });
    expect(r.ok).toBe(false);
  });

  it("sans identifiant, pose « À désigner » — un état normal, pas une erreur", async () => {
    const r = await resolveHomePick(db(), "t1", {});
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: null, homeGuestId: null, homeDisplayName: "À désigner", clt: null },
    });
  });

  it("ignore un nom LIBRE glissé dans le corps : c'était la porte de contournement", async () => {
    const r = await resolveHomePick(db(), "t1", {
      homeDisplayName: "Joueur hors équipe",
    } as never);
    expect(r.ok && r.value.homeDisplayName).toBe("À désigner");
  });

  it("traite une chaîne vide comme une absence de choix, pas comme un identifiant", async () => {
    const r = await resolveHomePick(db(), "t1", { userId: "", guestId: "" });
    expect(r.ok && r.value.homeUserId).toBeNull();
  });
});

// La composition entière d'une rencontre passait par une boucle appelant `resolveHomePick`,
// donc une requête PAR LIGNE, sérialisées. Ce qui est éprouvé ici : deux requêtes au total, et
// des décisions identiques à celles de la version unitaire — c'est la seule raison qui rend le
// groupage acceptable.
describe("resolveHomePicks", () => {
  /** Faux client groupé : compte les appels et honore le filtre `id in […]`. */
  function bulkDb(users: Record<string, unknown> = {}, guests: Record<string, unknown> = {}) {
    const calls = { user: 0, guest: 0 };
    const client = {
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          calls.user += 1;
          return where.id.in.map((id) => users[id]).filter(Boolean);
        },
      },
      interclubGuest: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          calls.guest += 1;
          return where.id.in.map((id) => guests[id]).filter(Boolean);
        },
      },
    } as never;
    return { client, calls };
  }

  it("résout huit lignes en deux requêtes au plus", async () => {
    const users = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `u${i}`,
        membre({ id: `u${i}`, squashnetRanking: { clt: "5A" } }),
      ]),
    );
    const { client, calls } = bulkDb(users);
    const res = await resolveHomePicks(
      client,
      "t1",
      Array.from({ length: 8 }, (_, i) => ({ userId: `u${i}` })),
    );
    expect(res).toHaveLength(8);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(calls.user).toBe(1);
    expect(calls.guest).toBe(0);
  });

  it("rend les résultats DANS L'ORDRE reçu, refus compris", async () => {
    const { client } = bulkDb(
      {
        u1: membre({ id: "u1", squashnetRanking: { clt: "5A" } }),
        u2: membre({ id: "u2", teamId: "t2" }),
      },
      { g1: { id: "g1", name: "Paul", teamId: "t1", clt: "4D" } },
    );
    const res = await resolveHomePicks(client, "t1", [
      { userId: "u1" },
      { userId: "u2" },
      {},
      { guestId: "g1" },
      { userId: "u1", guestId: "g1" },
    ]);
    expect(res[0].ok).toBe(true);
    expect(res[1]).toMatchObject({ ok: false });
    expect(res[2].ok && res[2].value.homeUserId).toBeNull();
    expect(res[3].ok && res[3].value.homeGuestId).toBe("g1");
    expect(res[4]).toMatchObject({ ok: false });
  });

  it("applique les MÊMES refus que la version unitaire", async () => {
    const cas: { pick: Record<string, unknown>; users: Record<string, unknown> }[] = [
      { pick: { userId: "fantôme" }, users: {} },
      { pick: { userId: "u1" }, users: { u1: membre({ teamId: "t2" }) } },
      { pick: { userId: "u1" }, users: { u1: membre({ disabledAt: new Date() }) } },
    ];
    for (const { pick, users } of cas) {
      const seul = await resolveHomePick(db(users), "t1", pick);
      const groupe = await resolveHomePicks(bulkDb(users).client, "t1", [pick]);
      expect(groupe[0]).toEqual(seul);
    }
  });

  it("n'interroge rien quand aucune ligne ne nomme personne", async () => {
    const { client, calls } = bulkDb();
    const res = await resolveHomePicks(client, "t1", [{}, { userId: "" }, {}]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(calls).toEqual({ user: 0, guest: 0 });
  });
});

describe("findAlignmentClash", () => {
  /** Faux client : rend le match en conflit qu'on lui a donné, et retient la clause `where`. */
  function matchDb(clash: { order: number } | null) {
    const vu: { where?: Record<string, unknown> } = {};
    const client = {
      interclubMatch: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          vu.where = args.where;
          return clash;
        },
      },
    } as never;
    return { client, vu };
  }

  it("rend le numéro du simple où le joueur est déjà aligné", async () => {
    const { client } = matchDb({ order: 3 });
    const n = await findAlignmentClash(client, "f1", "m1", { homeUserId: "u1", homeGuestId: null });
    expect(n).toBe(3);
  });

  it("cherche dans la MÊME rencontre, en s'excluant soi-même", async () => {
    const { client, vu } = matchDb(null);
    await findAlignmentClash(client, "f1", "m1", { homeUserId: "u1", homeGuestId: null });
    expect(vu.where).toEqual({ interclubId: "f1", id: { not: "m1" }, homeUserId: "u1" });
  });

  it("« à désigner » n'est jamais un doublon : plusieurs simples peuvent l'être", async () => {
    const { client, vu } = matchDb({ order: 2 });
    const n = await findAlignmentClash(client, "f1", "m1", { homeUserId: null, homeGuestId: null });
    expect(n).toBeNull();
    expect(vu.where).toBeUndefined(); // pas même de requête émise
  });

  it("s'applique aussi aux invités", async () => {
    const { client, vu } = matchDb(null);
    await findAlignmentClash(client, "f1", "m1", { homeUserId: null, homeGuestId: "g1" });
    expect(vu.where).toMatchObject({ homeGuestId: "g1" });
  });
});

describe("findOrderConflict", () => {
  /**
   * Faux client combinant les trois lectures : les simples voisins (`interclubMatch`), et le
   * classement de ceux d'entre eux qui portent un membre ou un invité.
   */
  function orderDb(
    siblings: { order: number; homeDisplayName: string; homeUserId: string | null; homeGuestId: string | null }[],
    users: Record<string, { interclubCltOverride: string | null; squashnetRanking: { clt: string } | null }> = {},
    guests: Record<string, { clt: string | null }> = {},
  ) {
    return {
      interclubMatch: { findMany: async () => siblings },
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => id in users).map((id) => ({ id, ...users[id] })),
      },
      interclubGuest: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => id in guests).map((id) => ({ id, ...guests[id] })),
      },
    } as never;
  }

  it("« à désigner » n'a jamais de conflit d'ordre — on ne relit même pas les voisins", async () => {
    let lu = false;
    const client = {
      interclubMatch: {
        findMany: async () => {
          lu = true;
          return [];
        },
      },
      user: { findMany: async () => [] },
      interclubGuest: { findMany: async () => [] },
    } as never;
    const pb = await findOrderConflict(client, "f1", "m1", {
      order: 1,
      clt: null,
      name: "À désigner",
    });
    expect(pb).toBeNull();
    expect(lu).toBe(false);
  });

  it("accepte un candidat dont le classement respecte l'ordre des voisins", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: { interclubCltOverride: null, squashnetRanking: { clt: "4D" } } },
    );
    const pb = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "5A",
      name: "Benoît",
    });
    expect(pb).toBeNull();
  });

  it("refuse Benoît (4D) au simple 2 quand Albert (5A) joue déjà le simple 1", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: { interclubCltOverride: null, squashnetRanking: { clt: "5A" } } },
    );
    const pb = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "4D",
      name: "Benoît",
    });
    expect(pb).toContain("Benoît");
  });

  it("relit le classement des invités voisins comme celui des membres", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Gabin", homeUserId: null, homeGuestId: "g1" }],
      {},
      { g1: { clt: "5A" } },
    );
    // Gabin (5A) en simple 1, Benoît (NC, plus faible) en simple 2 : ordre respecté.
    const ok = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "NC",
      name: "Benoît",
    });
    expect(ok).toBeNull();

    // L'inverse — Benoît (NC) en simple 1 pendant que Gabin (5A, mieux classé) attend au
    // simple 2 — viole l'ordre, invité compris.
    const clientInverse = orderDb(
      [{ order: 1, homeDisplayName: "Benoît", homeUserId: null, homeGuestId: "g1" }],
      {},
      { g1: { clt: "NC" } },
    );
    const pb = await findOrderConflict(clientInverse, "f1", "m2", {
      order: 2,
      clt: "5A",
      name: "Gabin",
    });
    expect(pb).toContain("Gabin");
  });

  it("exclut le simple qu'on modifie de la liste des voisins", async () => {
    let vu: Record<string, unknown> | undefined;
    const client = {
      interclubMatch: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          vu = args.where;
          return [];
        },
      },
      user: { findMany: async () => [] },
      interclubGuest: { findMany: async () => [] },
    } as never;
    await findOrderConflict(client, "f1", "m1", { order: 1, clt: "5A", name: "Albert" });
    expect(vu).toEqual({ interclubId: "f1", id: { not: "m1" } });
  });
});
