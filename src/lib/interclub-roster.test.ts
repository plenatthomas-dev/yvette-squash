import { describe, it, expect, beforeEach, vi } from "vitest";

// La règle du club vit dans ce module : « seuls les joueurs de l'équipe qui dispute la
// rencontre peuvent être alignés, et un joueur ne dispute qu'un simple ». Elle n'était jusqu'ici
// éprouvée qu'à travers les tests de routes ; ici on la vérifie à la source.

const h = vi.hoisted(() => ({
  membres: [] as Array<{ id: string; displayName: string; nickname: string | null }>,
  invites: [] as Array<{ id: string; name: string }>,
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
});

describe("resolveHomePick", () => {
  it("accepte un membre de l'équipe et fige son nom d'affichage", async () => {
    const r = await resolveHomePick(db({ u1: membre({ nickname: "Tom" }) }), "t1", { userId: "u1" });
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: "u1", homeGuestId: null, homeDisplayName: "Tom" },
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
    const guests = { g1: { id: "g1", name: "Marc", teamId: "t1" }, g2: { id: "g2", name: "Luc", teamId: "t2" } };
    const ok = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(ok).toEqual({
      ok: true,
      value: { homeUserId: null, homeGuestId: "g1", homeDisplayName: "Marc" },
    });
    expect((await resolveHomePick(db({}, guests), "t1", { guestId: "g2" })).ok).toBe(false);
  });

  it("refuse de désigner à la fois un membre et un invité", async () => {
    const r = await resolveHomePick(db(), "t1", { userId: "u1", guestId: "g1" });
    expect(r.ok).toBe(false);
  });

  it("sans identifiant, pose « À désigner » — un état normal, pas une erreur", async () => {
    const r = await resolveHomePick(db(), "t1", {});
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: null, homeGuestId: null, homeDisplayName: "À désigner" },
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
      Array.from({ length: 8 }, (_, i) => [`u${i}`, membre({ id: `u${i}` })]),
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
      { u1: membre({ id: "u1" }), u2: membre({ id: "u2", teamId: "t2" }) },
      { g1: { id: "g1", name: "Paul", teamId: "t1" } },
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
