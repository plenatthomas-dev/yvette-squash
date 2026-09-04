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
  allTeamMembers,
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
  interclubRangMOverride: null,
  squashnetRanking: null,
  ...over,
});

/**
 * Un joueur sans compte, avec ses deux étages : la correction admin et le rapprochement
 * squashnet — la même structure qu'un membre, colonnes à plat. `snClt`/`snRangM` par défaut,
 * puisque le rapprochement est désormais la voie NORMALE et la saisie manuelle le repli.
 */
const invite = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  name: "Marc",
  teamId: "t1",
  cltOverride: null,
  rangMOverride: null,
  snClt: null,
  snRangM: null,
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

  it("classement d'un invité : le rapprochement squashnet, la correction admin l'emportant", async () => {
    h.invites = [invite({ id: "g1", name: "Émile", snClt: "5A" }) as never];
    expect((await teamRoster("t1"))[0].clt).toBe("5A");

    h.invites = [invite({ id: "g1", name: "Émile", snClt: "5A", cltOverride: "4D" }) as never];
    expect((await teamRoster("t1"))[0].clt).toBe("4D");
  });

  it("rangM d'un membre : le rapprochement squashnet, la correction admin l'emportant", async () => {
    h.membres = [membre({ id: "u1", displayName: "Zoé", squashnetRanking: { clt: "5A", rangM: 412 } })];
    expect((await teamRoster("t1"))[0].rangM).toBe(412);

    h.membres = [
      membre({
        id: "u1",
        displayName: "Zoé",
        interclubRangMOverride: 900,
        squashnetRanking: { clt: "5A", rangM: 412 },
      }),
    ];
    expect((await teamRoster("t1"))[0].rangM).toBe(900);
  });

  it("les deux corrections sont INDÉPENDANTES : forcer le classement laisse le rang rapproché", async () => {
    h.membres = [
      membre({
        id: "u1",
        displayName: "Zoé",
        interclubCltOverride: "4D",
        squashnetRanking: { clt: "5A", rangM: 412 },
      }),
    ];
    expect(await teamRoster("t1")).toMatchObject([{ clt: "4D", rangM: 412 }]);
  });

  it("rangM d'un membre : `null` sans rapprochement", async () => {
    h.membres = [membre({ id: "u1", displayName: "Zoé" })];
    expect((await teamRoster("t1"))[0].rangM).toBeNull();
  });

  it("rangM d'un invité : rapproché comme celui d'un membre — un joueur sans compte reste licencié", async () => {
    h.invites = [invite({ id: "g1", name: "Émile", snClt: "4D", snRangM: 812 }) as never];
    expect((await teamRoster("t1"))[0].rangM).toBe(812);

    h.invites = [
      invite({ id: "g1", name: "Émile", snClt: "4D", snRangM: 812, rangMOverride: 700 }) as never,
    ];
    expect((await teamRoster("t1"))[0].rangM).toBe(700);
  });
});

// L'écran d'admin « Équipes interclub » ne comptait les membres que par leur NOMBRE : il fallait
// ouvrir la page Membres à côté pour savoir qui compose une équipe, et à quel classement. Cette
// fonction sert cet écran-là — d'où la lecture de TOUTES les équipes d'un coup.
describe("allTeamMembers", () => {
  it("porte l'équipe de chaque membre, son nom d'affichage et son classement effectif", async () => {
    h.membres = [
      membre({
        id: "u1",
        displayName: "Jérôme Blanc",
        nickname: "Jéjé",
        teamId: "t7",
        squashnetRanking: { clt: "5A", rangM: 412 },
      }),
    ];
    expect(await allTeamMembers()).toEqual([
      { kind: "member", id: "u1", teamId: "t7", name: "Jéjé", clt: "5A", rangM: 412 },
    ]);
  });

  it("applique la MÊME priorité de classement que le reste du module (correction admin d'abord)", async () => {
    h.membres = [
      membre({ id: "u1", interclubCltOverride: "4D", squashnetRanking: { clt: "5A", rangM: 412 } }),
    ];
    const [m] = await allTeamMembers();
    // Le rang, lui, reste celui de squashnet : les deux corrections sont indépendantes, et
    // celle-ci ne porte qu'un classement.
    expect(m).toMatchObject({ clt: "4D", rangM: 412 });
  });

  it("ne lit que les membres RATTACHÉS à une équipe, comptes désactivés exclus", async () => {
    await allTeamMembers();
    expect(h.dernierWhereUser).toEqual({ teamId: { not: null }, disabledAt: null });
  });

  it("trie par nom — la base alphabétique stable sur laquelle l'écran retrie par classement", async () => {
    h.membres = [
      membre({ id: "u1", displayName: "Zoé" }),
      membre({ id: "u2", displayName: "Émile" }),
      membre({ id: "u3", displayName: "Bernard", nickname: "Bébert" }),
    ];
    expect((await allTeamMembers()).map((m) => m.name)).toEqual(["Bébert", "Émile", "Zoé"]);
  });
});

describe("resolveHomePick", () => {
  it("accepte un membre de l'équipe et fige son nom d'affichage", async () => {
    const r = await resolveHomePick(
      db({ u1: membre({ nickname: "Tom", squashnetRanking: { clt: "5A", rangM: 1200 } }) }),
      "t1",
      { userId: "u1" },
    );
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: "u1", homeGuestId: null, homeDisplayName: "Tom", clt: "5A", rangM: 1200 },
    });
  });

  it("refuse un membre classé dont le rang mixte est inconnu — il départage les ex æquo", async () => {
    const r = await resolveHomePick(
      db({ u1: membre({ nickname: "Tom", squashnetRanking: { clt: "5A", rangM: null } }) }),
      "t1",
      { userId: "u1" },
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toContain("rang mixte inconnu");
  });

  it("accepte un NC SANS rang mixte : la fédération ne les ordonne pas entre eux", async () => {
    const r = await resolveHomePick(
      db({ u1: membre({ nickname: "Tom", squashnetRanking: { clt: "NC", rangM: null } }) }),
      "t1",
      { userId: "u1" },
    );
    expect(r).toEqual({
      ok: true,
      value: { homeUserId: "u1", homeGuestId: null, homeDisplayName: "Tom", clt: "NC", rangM: null },
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
      g1: invite({ id: "g1", name: "Marc", teamId: "t1", snClt: "4D", snRangM: 812 }),
      g2: invite({ id: "g2", name: "Luc", teamId: "t2", snClt: "4D", snRangM: 900 }),
    };
    const ok = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(ok).toEqual({
      ok: true,
      value: { homeUserId: null, homeGuestId: "g1", homeDisplayName: "Marc", clt: "4D", rangM: 812 },
    });
    expect((await resolveHomePick(db({}, guests), "t1", { guestId: "g2" })).ok).toBe(false);
  });

  it("refuse un invité sans classement connu", async () => {
    const guests = { g1: invite({ id: "g1", name: "Marc", teamId: "t1" }) };
    const r = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(r).toEqual({
      ok: false,
      error: "Marc : classement inconnu — attribue-lui un classement avant de le désigner",
    });
  });

  it("refuse un invité classé mais sans rang mixte — même exigence que pour un membre", async () => {
    const guests = { g1: invite({ id: "g1", name: "Marc", teamId: "t1", snClt: "4D" }) };
    const r = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(r.ok === false && r.error).toContain("rang mixte inconnu");
  });

  it("un invité forcé à la main est alignable : c'est tout l'objet du repli admin", async () => {
    const guests = {
      g1: invite({ id: "g1", name: "Marc", teamId: "t1", cltOverride: "5A", rangMOverride: 1500 }),
    };
    const r = await resolveHomePick(db({}, guests), "t1", { guestId: "g1" });
    expect(r).toMatchObject({ ok: true, value: { clt: "5A", rangM: 1500 } });
  });

  it("refuse de désigner à la fois un membre et un invité", async () => {
    const r = await resolveHomePick(db(), "t1", { userId: "u1", guestId: "g1" });
    expect(r.ok).toBe(false);
  });

  it("sans identifiant, pose « À désigner » — un état normal, pas une erreur", async () => {
    const r = await resolveHomePick(db(), "t1", {});
    expect(r).toEqual({
      ok: true,
      value: {
        homeUserId: null,
        homeGuestId: null,
        homeDisplayName: "À désigner",
        clt: null,
        rangM: null,
      },
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
        membre({ id: `u${i}`, squashnetRanking: { clt: "5A", rangM: 1000 + i } }),
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
        u1: membre({ id: "u1", squashnetRanking: { clt: "5A", rangM: 1200 } }),
        u2: membre({ id: "u2", teamId: "t2" }),
      },
      { g1: invite({ id: "g1", name: "Paul", teamId: "t1", snClt: "4D", snRangM: 812 }) },
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
   * classement EFFECTIF — classement ET rang mixte — de ceux d'entre eux qui portent un membre
   * ou un joueur sans compte.
   */
  function orderDb(
    siblings: { order: number; homeDisplayName: string; homeUserId: string | null; homeGuestId: string | null }[],
    users: Record<
      string,
      {
        interclubCltOverride: string | null;
        interclubRangMOverride: number | null;
        squashnetRanking: { clt: string; rangM: number | null } | null;
      }
    > = {},
    guests: Record<
      string,
      { cltOverride: string | null; rangMOverride: number | null; snClt: string | null; snRangM: number | null }
    > = {},
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

  /** Un membre rapproché sur squashnet, sans correction admin — le cas courant. */
  function membre(clt: string, rangM: number | null) {
    return { interclubCltOverride: null, interclubRangMOverride: null, squashnetRanking: { clt, rangM } };
  }

  /** Un joueur sans compte rapproché sur squashnet, sans correction admin. */
  function invite(snClt: string | null, snRangM: number | null) {
    return { cltOverride: null, rangMOverride: null, snClt, snRangM };
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
      rangM: null,
      name: "À désigner",
    });
    expect(pb).toBeNull();
    expect(lu).toBe(false);
  });

  it("accepte un candidat dont le classement respecte l'ordre des voisins", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: membre("4D", 800) },
    );
    const pb = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "5A",
      rangM: 1200,
      name: "Benoît",
    });
    expect(pb).toBeNull();
  });

  it("refuse Benoît (4D) au simple 2 quand Albert (5A) joue déjà le simple 1", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: membre("5A", 1200) },
    );
    const pb = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "4D",
      rangM: 800,
      name: "Benoît",
    });
    expect(pb).toContain("Benoît");
  });

  it("relit le RANG MIXTE des voisins, pas seulement leur classement", async () => {
    // Deux « 5A » : c'est le rang qui décide, et le voisin n'est comparable que si son rang a
    // bien été relu — l'oublier ferait réclamer un rang mixte pourtant renseigné en base.
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: membre("5A", 1200) },
    );
    expect(
      await findOrderConflict(client, "f1", "m2", { order: 2, clt: "5A", rangM: 1500, name: "Benoît" }),
    ).toBeNull();
    expect(
      await findOrderConflict(client, "f1", "m2", { order: 2, clt: "5A", rangM: 900, name: "Benoît" }),
    ).toContain("Benoît");
  });

  it("relit la correction admin du rang mixte, prioritaire sur le rapprochement", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      {
        // squashnet dit 1200, l'admin a corrigé à 1800 : Benoît (1500) passe donc devant, et
        // l'aligner APRÈS Albert est un conflit.
        u1: { interclubCltOverride: null, interclubRangMOverride: 1800, squashnetRanking: { clt: "5A", rangM: 1200 } },
      },
    );
    expect(
      await findOrderConflict(client, "f1", "m2", { order: 2, clt: "5A", rangM: 1500, name: "Benoît" }),
    ).toContain("Benoît");
  });

  it("relit le classement des invités voisins comme celui des membres", async () => {
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Gabin", homeUserId: null, homeGuestId: "g1" }],
      {},
      { g1: invite("5A", 1200) },
    );
    // Gabin (5A) en simple 1, Benoît (NC, plus faible) en simple 2 : ordre respecté.
    const ok = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "NC",
      rangM: null,
      name: "Benoît",
    });
    expect(ok).toBeNull();

    // L'inverse — Benoît (NC) en simple 1 pendant que Gabin (5A, mieux classé) attend au
    // simple 2 — viole l'ordre, invité compris.
    const clientInverse = orderDb(
      [{ order: 1, homeDisplayName: "Benoît", homeUserId: null, homeGuestId: "g1" }],
      {},
      { g1: invite("NC", null) },
    );
    const pb = await findOrderConflict(clientInverse, "f1", "m2", {
      order: 2,
      clt: "5A",
      rangM: 1200,
      name: "Gabin",
    });
    expect(pb).toContain("Gabin");
  });

  it("refuse un voisin classé dont le rang mixte n'a jamais été établi", async () => {
    // Le trou est chez le VOISIN, pas chez le candidat : il faut quand même le dire, sinon la
    // composition serait acceptée sur un ordre invérifiable.
    const client = orderDb(
      [{ order: 1, homeDisplayName: "Albert", homeUserId: "u1", homeGuestId: null }],
      { u1: membre("4D", null) },
    );
    const pb = await findOrderConflict(client, "f1", "m2", {
      order: 2,
      clt: "5A",
      rangM: 1200,
      name: "Benoît",
    });
    expect(pb).toContain("Albert");
    expect(pb).toContain("rang mixte inconnu");
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
    await findOrderConflict(client, "f1", "m1", { order: 1, clt: "5A", rangM: 1200, name: "Albert" });
    expect(vu).toEqual({ interclubId: "f1", id: { not: "m1" } });
  });
});
