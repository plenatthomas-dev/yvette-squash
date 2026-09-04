import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// État mutable partagé, hoisté pour être visible des factories vi.mock (hoistées en tête).
const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  teams: [] as Array<Record<string, unknown>>,
  team: null as null | Record<string, unknown>,
  /** Le membre que `resolveHomePick` trouvera (ou non) — un seul suffit à la plupart des tests. */
  user: null as null | Record<string, unknown>,
  /** Membres SUPPLÉMENTAIRES, pour les tests qui composent plusieurs simples à la fois. */
  users: [] as Array<Record<string, unknown>>,
  /** Idem pour un joueur d'équipe sans compte. */
  guest: null as null | Record<string, unknown>,
  fixtures: [] as Array<Record<string, unknown>>,
  created: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      findUnique: vi.fn(async () => h.team),
    },
    interclub: {
      findMany: vi.fn(async () => h.fixtures),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created = args.data;
        return { id: "f1" };
      }),
    },
    // `findMany` sert la résolution GROUPÉE de la composition (deux requêtes pour toute la
    // rencontre, cf. `resolveHomePicks`). Le filtre par id est reproduit ici : sans lui, un
    // identifiant inconnu remonterait quand même la seule ligne du bouchon, et le test « membre
    // inconnu » passerait pour de mauvaises raisons.
    user: {
      findUnique: vi.fn(async () => h.user),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        [...(h.user ? [h.user] : []), ...h.users].filter((u) =>
          args.where.id.in.includes(u.id as string),
        ),
      ),
    },
    interclubGuest: {
      findUnique: vi.fn(async () => h.guest),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        h.guest && args.where.id.in.includes(h.guest.id as string) ? [h.guest] : [],
      ),
    },
  },
}));

import { GET, POST } from "./route";

const req = () =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams() },
  }) as unknown as NextRequest;

const post = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
  }) as unknown as NextRequest;

const validBody = {
  date: "2026-09-03",
  teamId: "t1",
  opponent: "Squash de Massy",
};

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.teams = [{ id: "t1", name: "Équipe 1" }];
  h.team = { id: "t1", name: "Équipe 1" };
  h.user = null;
  h.users = [];
  h.guest = null;
  h.fixtures = [];
  h.created = null;
});

describe("GET /api/interclub", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie les équipes et les rencontres avec leur score", async () => {
    h.fixtures = [
      {
        id: "f1",
        date: "2026-09-03",
        time: "20:00",
        venue: "SQUASH DE L YVETTE",
        venueAddress: "1 rue du squash",
        round: "J3",
        dateConfirmed: true,
        team: {
          id: "t1",
          name: "Équipe 1",
          captainId: "u9",
          captain: { displayName: "Xavier Le Marquis", nickname: null },
        },
        opponent: "Massy",
        home: true,
        division: "D2",
        matchCount: 4,
        matches: [
          { gamesHome: 3, gamesAway: 0, status: "done", games: [] },
          { gamesHome: 1, gamesAway: 3, status: "done", games: [] },
          { gamesHome: null, gamesAway: null, status: "pending", games: [] },
          { gamesHome: null, gamesAway: null, status: "pending", games: [] },
        ],
      },
    ];
    const body = await (await GET(req())).json();
    expect(body.teams).toHaveLength(1);
    expect(body.fixtures[0].score).toEqual({ home: 1, away: 1 });
    // Deux matchs sur quatre saisis ⇒ la rencontre est en cours, pas terminée.
    expect(body.fixtures[0].status).toBe("live");
  });

  /** Une rencontre minimale, dont seuls les simples changent d'un test à l'autre. */
  const rencontre = (matches: Array<Record<string, unknown>>) => ({
    id: "f1",
    date: "2026-09-03",
    time: "20:00",
    venue: null,
    venueAddress: null,
    round: "J3",
    dateConfirmed: true,
    team: { id: "t1", name: "Équipe 1", captainId: null, captain: null },
    opponent: "Massy",
    home: true,
    division: "D4",
    matchCount: 4,
    matches,
  });

  it("dit ce que la rencontre RAPPORTE, pas seulement son score", async () => {
    // Un 2-2 vaut deux points de classement ou un seul selon l'average : le score seul laisse
    // la question ouverte, et la liste est l'écran où on lit sa saison.
    const trois = (a: number, b: number) => [
      { pointsHome: a, pointsAway: b },
      { pointsHome: a, pointsAway: b },
      { pointsHome: a, pointsAway: b },
    ];
    h.fixtures = [
      rencontre([
        { gamesHome: 3, gamesAway: 0, status: "done", games: trois(11, 1) },
        { gamesHome: 3, gamesAway: 0, status: "done", games: trois(11, 1) },
        { gamesHome: 0, gamesAway: 3, status: "done", games: trois(9, 11) },
        { gamesHome: 0, gamesAway: 3, status: "done", games: trois(9, 11) },
      ]),
    ];
    const body = await (await GET(req())).json();
    expect(body.fixtures[0].score).toEqual({ home: 2, away: 2 });
    // Jeux 6-6, donc c'est l'average de POINTS qui tranche — 120 contre 72.
    expect(body.fixtures[0].outcome).toMatchObject({
      result: "drawWon",
      leaguePoints: 2,
      decidedBy: "rallies",
      games: { home: 6, away: 6 },
      rallies: { home: 120, away: 72 },
    });
  });

  it("ne prête aucun résultat à une rencontre qui n'est pas finie", async () => {
    // Deux simples sur quatre : annoncer « Victoire, 3 pts » à mi-parcours serait faux
    // pendant toute la soirée, c'est-à-dire pendant qu'on regarde.
    h.fixtures = [
      rencontre([
        { gamesHome: 3, gamesAway: 0, status: "done", games: [] },
        { gamesHome: 3, gamesAway: 0, status: "done", games: [] },
        { gamesHome: null, gamesAway: null, status: "pending", games: [] },
        { gamesHome: null, gamesAway: null, status: "pending", games: [] },
      ]),
    ];
    const body = await (await GET(req())).json();
    expect(body.fixtures[0].status).toBe("live");
    expect(body.fixtures[0].outcome).toBeNull();
  });

  it("porte ce qui fait d'une rencontre un RENDEZ-VOUS : journée, heure, lieu, capitaine", async () => {
    // Ces champs manquaient à cette route alors que l'écran les affiche déjà. Le plus coûteux
    // était `dateConfirmed` : indéfini, le composant le lit comme « non confirmée », et TOUTES
    // les lignes portaient la mention « prévisionnelle » — y compris les dates fermes. Une
    // mention qui s'affiche partout ne veut plus rien dire nulle part.
    h.fixtures = [
      {
        id: "f1",
        date: "2026-09-03",
        time: "20:00",
        venue: "SQUASH DE L YVETTE",
        venueAddress: "1 rue du squash",
        round: "J3",
        dateConfirmed: true,
        team: {
          id: "t1",
          name: "Équipe 1",
          captainId: "u9",
          captain: { displayName: "Xavier Le Marquis", nickname: null },
        },
        opponent: "Massy",
        home: true,
        division: "D2",
        matchCount: 4,
        matches: [],
      },
    ];
    const f = (await (await GET(req())).json()).fixtures[0];
    expect(f).toMatchObject({
      round: "J3",
      time: "20:00",
      venue: "SQUASH DE L YVETTE",
      venueAddress: "1 rue du squash",
      dateConfirmed: true,
    });
    expect(f.team).toMatchObject({ captainId: "u9", captainName: "Xavier Le Marquis" });
  });

  it("n'invente pas de capitaine quand l'équipe n'en a pas", async () => {
    h.fixtures = [
      {
        id: "f1",
        date: "2026-09-03",
        time: null,
        venue: null,
        venueAddress: null,
        round: null,
        dateConfirmed: false,
        team: { id: "t1", name: "Équipe 1", captainId: null, captain: null },
        opponent: "Massy",
        home: true,
        division: null,
        matchCount: 4,
        matches: [],
      },
    ];
    const f = (await (await GET(req())).json()).fixtures[0];
    expect(f.team.captainName).toBeNull();
    expect(f.dateConfirmed).toBe(false);
  });
});

describe("POST /api/interclub", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await POST(post(validBody))).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it("tout membre connecté peut créer une rencontre (aucun rôle exigé)", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(201);
    expect(h.created?.createdById).toBe("u1");
  });

  it("crée autant de simples que demandé, numérotés dans l'ordre", async () => {
    await POST(post({ ...validBody, matchCount: 4 }));
    const create = (h.created?.matches as { create: Array<{ order: number }> }).create;
    expect(create).toHaveLength(4);
    expect(create.map((m) => m.order)).toEqual([1, 2, 3, 4]);
  });

  it("fige le nom du membre aligné, pour survivre à une suppression de compte", async () => {
    h.user = {
      id: "u9",
      displayName: "Jérôme Blanc",
      nickname: "Jéjé",
      teamId: "t1",
      disabledAt: null,
      squashnetRanking: { clt: "5A", rangM: 1200 },
    };
    await POST(post({ ...validBody, matches: [{ userId: "u9", awayName: "Dupont" }] }));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeDisplayName).toBe("Jéjé");
    expect(create[0].homeUserId).toBe("u9");
    expect(create[0].awayName).toBe("Dupont");
  });

  // La règle du club, à la CRÉATION. Elle n'était appliquée que sur le PATCH d'un match :
  // cette route acceptait n'importe quel id de membre existant, quelle que soit son équipe.
  it("refuse d'aligner un membre d'une AUTRE équipe", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: "t2", disabledAt: null };
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/équipe qui dispute/i);
    expect(h.created).toBeNull();
  });

  it("refuse d'aligner un compte désactivé", async () => {
    h.user = {
      id: "u9",
      displayName: "Jérôme",
      nickname: null,
      teamId: "t1",
      disabledAt: new Date(),
    };
    expect((await POST(post({ ...validBody, matches: [{ userId: "u9" }] }))).status).toBe(400);
  });

  // Un nom LIBRE était la dernière porte par laquelle la règle se contournait : plus de champ
  // `name`, un joueur hors appli passe par le roster de son équipe.
  it("ignore un nom libre : sans identifiant, le simple reste « à désigner »", async () => {
    await POST(post({ ...validBody, matches: [{ name: "N'importe qui", awayName: "Dupont" }] }));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeDisplayName).toBe("À désigner");
    expect(create[0].homeUserId).toBeNull();
    expect(create[0].homeGuestId).toBeNull();
  });

  it("aligne un joueur hors appli inscrit au roster de l'équipe", async () => {
    h.guest = { id: "g1", name: "Paul Hors-Appli", teamId: "t1", snClt: "4D", snRangM: 812 };
    await POST(post({ ...validBody, matches: [{ guestId: "g1" }] }));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeGuestId).toBe("g1");
    expect(create[0].homeUserId).toBeNull();
    expect(create[0].homeDisplayName).toBe("Paul Hors-Appli");
  });

  it("refuse un joueur hors appli rattaché à une autre équipe", async () => {
    h.guest = { id: "g1", name: "Paul", teamId: "t2" };
    expect((await POST(post({ ...validBody, matches: [{ guestId: "g1" }] }))).status).toBe(400);
  });

  it("laisse la composition ouverte quand elle n'est pas fournie", async () => {
    await POST(post(validBody));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeDisplayName).toBe("À désigner");
    expect(create[0].homeUserId).toBeNull();
  });

  it("refuse une date mal formée", async () => {
    expect((await POST(post({ ...validBody, date: "03/09/2026" }))).status).toBe(400);
  });

  // La forme ne suffisait pas : la colonne est un `String` et le tri est lexicographique, donc
  // une date impossible remonte en tête de la liste ET satisfait le plancher du bandeau direct,
  // où elle occupe une place que la borne de deux jours ne peut plus lui reprendre.
  it("refuse une date bien formée mais qui n'existe pas", async () => {
    expect((await POST(post({ ...validBody, date: "2026-13-45" }))).status).toBe(400);
    expect((await POST(post({ ...validBody, date: "2026-02-31" }))).status).toBe(400);
    expect((await POST(post({ ...validBody, date: "2026-99-99" }))).status).toBe(400);
  });

  it("accepte un 29 février d'année bissextile, qui existe bel et bien", async () => {
    expect((await POST(post({ ...validBody, date: "2028-02-29" }))).status).toBe(201);
  });

  // Un corps `null` est du JSON VALIDE : `json()` résout, et c'est la déstructuration qui
  // levait — un 500 non géré là où toute autre malformation finit en 400 propre.
  it("refuse proprement un corps `null` au lieu de sortir en 500", async () => {
    expect((await POST(post(null))).status).toBe(400);
    expect((await POST(post(5))).status).toBe(400);
  });

  it("refuse un club adverse vide", async () => {
    expect((await POST(post({ ...validBody, opponent: "   " }))).status).toBe(400);
  });

  it("refuse une équipe inconnue", async () => {
    h.team = null;
    expect((await POST(post(validBody))).status).toBe(400);
  });

  it("refuse un format autre que le meilleur des 3 ou des 5", async () => {
    expect((await POST(post({ ...validBody, bestOf: 4 }))).status).toBe(400);
  });

  it("refuse un nombre de matchs hors bornes", async () => {
    expect((await POST(post({ ...validBody, matchCount: 0 }))).status).toBe(400);
    expect((await POST(post({ ...validBody, matchCount: 99 }))).status).toBe(400);
  });

  it("refuse d'aligner deux fois le même membre", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: "t1", disabledAt: null };
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }, { userId: "u9" }] }));
    expect(res.status).toBe(400);
  });

  it("refuse ce qui n'est pas une couleur", async () => {
    const res = await POST(post({ ...validBody, matches: [{ homeColor: "bleu-ciel" }] }));
    expect(res.status).toBe(400);
  });

  it("accepte une couleur libre et la normalise", async () => {
    await POST(post({ ...validBody, matches: [{ homeColor: "#A1B2C3" }] }));
    const create = (h.created?.matches as { create: Array<Record<string, unknown>> }).create;
    expect(create[0].homeColor).toBe("#a1b2c3");
  });

  it("refuse plus de joueurs que de matchs", async () => {
    const res = await POST(post({ ...validBody, matchCount: 1, matches: [{}, {}] }));
    expect(res.status).toBe(400);
  });

  // --- Ordre des simples par classement -------------------------------------

  it("refuse une composition qui romprait l'ordre des simples par classement", async () => {
    h.users = [
      {
        id: "u-albert",
        displayName: "Albert",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "5A", rangM: 1200 },
      },
      {
        id: "u-benoit",
        displayName: "Benoît",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "4D", rangM: 800 },
      },
    ];
    // Albert (5A) au simple 1, Benoît (4D, MIEUX classé) au simple 2 : ordre rompu.
    const res = await POST(
      post({ ...validBody, matches: [{ userId: "u-albert" }, { userId: "u-benoit" }] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Benoît");
    expect(h.created).toBeNull();
  });

  it("accepte une composition qui respecte l'ordre des simples par classement", async () => {
    h.users = [
      {
        id: "u-albert",
        displayName: "Albert",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "4D", rangM: 800 },
      },
      {
        id: "u-benoit",
        displayName: "Benoît",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "5A", rangM: 1200 },
      },
    ];
    const res = await POST(
      post({ ...validBody, matches: [{ userId: "u-albert" }, { userId: "u-benoit" }] }),
    );
    expect(res.status).toBe(201);
  });

  it("refuse deux joueurs de MÊME classement rangés à l'envers — le rang mixte départage", async () => {
    // Deux « 5A » ne sont pas interchangeables : la règle de la compétition ordonne aussi par
    // rang mixte à classement égal, et une rencontre composée à l'envers est sanctionnable.
    h.users = [
      {
        id: "u-albert",
        displayName: "Albert",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "5A", rangM: 1500 },
      },
      {
        id: "u-benoit",
        displayName: "Benoît",
        nickname: null,
        teamId: "t1",
        disabledAt: null,
        interclubCltOverride: null,
        squashnetRanking: { clt: "5A", rangM: 1200 },
      },
    ];
    const res = await POST(
      post({ ...validBody, matches: [{ userId: "u-albert" }, { userId: "u-benoit" }] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Benoît");
    expect(h.created).toBeNull();
  });

  it("refuse de composer un joueur classé dont le rang mixte est inconnu", async () => {
    h.user = {
      id: "u9",
      displayName: "Jérôme",
      nickname: null,
      teamId: "t1",
      disabledAt: null,
      squashnetRanking: { clt: "5A", rangM: null },
    };
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rang mixte inconnu");
    expect(h.created).toBeNull();
  });

  it("compose un NC sans rang mixte : la fédération ne les ordonne pas entre eux", async () => {
    h.user = {
      id: "u9",
      displayName: "Jérôme",
      nickname: null,
      teamId: "t1",
      disabledAt: null,
      squashnetRanking: { clt: "NC", rangM: null },
    };
    expect((await POST(post({ ...validBody, matches: [{ userId: "u9" }] }))).status).toBe(201);
  });

  it("n'exige pas de COMPARAISON de classement quand un seul simple est composé, mais exige quand même de le connaître", async () => {
    // `lineupOrderConflict` seul ne réclame rien tant qu'il n'y a personne à comparer — mais
    // `resolveHomePicks` (donc `decideMember`) refuse maintenant tout joueur dont le classement
    // est inconnu, quel que soit le nombre de simples déjà composés : sans classement, il ne
    // peut disputer AUCUN simple.
    h.user = {
      id: "u9",
      displayName: "Jérôme",
      nickname: null,
      teamId: "t1",
      disabledAt: null,
      squashnetRanking: { clt: "5A", rangM: 1200 },
    };
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }] }));
    expect(res.status).toBe(201);
  });

  it("refuse de composer le tout premier simple avec un joueur sans classement connu", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: "t1", disabledAt: null };
    const res = await POST(post({ ...validBody, matches: [{ userId: "u9" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/classement inconnu/);
    expect(h.created).toBeNull();
  });
});
