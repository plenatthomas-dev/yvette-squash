import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { MIN_PLAYERS, MAX_PLAYERS } from "@/lib/tournament";

// La création d'un tournoi est la SEULE porte d'entrée du roster : tout ce qu'elle laisse
// passer, les vingt écrans suivants le tiennent pour acquis. Elle refuse par neuf chemins
// distincts — et pas un n'était couvert. Un seul de ces refus qui saute, et on obtient un
// tournoi à trois joueurs, une date « 14/11/2026 » que le tri par chaîne range n'importe où,
// ou deux fois le même membre dans la même poule — que `snakeGroups` répartira sans broncher,
// et qui devra alors se jouer contre lui-même.

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string; resa?: unknown },
  users: [] as { id: string; displayName: string; nickname: string | null }[],
  findMany: vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]),
  create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "t-neuf" })),
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: h.featureOn,
    ranking: false,
  }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tournament: {
      findMany: (args: Record<string, unknown>) => h.findMany(args),
      create: (args: { data: Record<string, unknown> }) => h.create(args),
    },
    user: { findMany: async () => h.users },
  },
}));

import { GET, POST } from "./route";

const get = (qs = "") =>
  ({
    cookies: { get: () => undefined },
    nextUrl: new URL(`https://exemple.test/api/tournaments${qs}`),
  }) as unknown as NextRequest;

const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

/** Un corps valide minimal — chaque test n'en abîme qu'un champ. */
const corps = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-14",
  targetMatches: 3,
  players: Array.from({ length: MIN_PLAYERS }, (_, i) => ({ guestName: `J${i + 1}` })),
  ...over,
});

/** Complète un début de roster jusqu'à MIN_PLAYERS avec des invités. */
const avec = (debut: unknown[]) => [
  ...debut,
  ...Array.from({ length: MIN_PLAYERS - debut.length }, (_, i) => ({ guestName: `J${i}` })),
];

/** Les données réellement passées à `tournament.create`. */
const cree = () => h.create.mock.calls[0][0].data;
const joueursCrees = () =>
  (cree().players as { create: Record<string, unknown>[] }).create;

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1", resa: { id: 42 } };
  h.users = [];
  h.findMany.mockClear().mockResolvedValue([]);
  h.create.mockClear();
});

describe("GET /api/tournaments", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await GET(get())).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(get())).status).toBe(401);
  });

  it("demande UNE ligne de plus que la limite, pour savoir s'il en reste", async () => {
    await GET(get());
    expect(h.findMany.mock.calls[0][0]).toMatchObject({ take: 21, orderBy: { createdAt: "desc" } });
  });

  it("plafonne la limite à 100, quoi qu'on demande", async () => {
    // Sans plafond, `?limit=100000` fait charger toute la table dans une seule réponse JSON.
    await GET(get("?limit=100000"));
    expect(h.findMany.mock.calls[0][0].take).toBe(101);
  });

  it.each([
    ["absente", "", 20],
    ["zéro", "?limit=0", 20],
    ["négative", "?limit=-5", 20],
    ["non numérique", "?limit=abc", 20],
    ["fractionnaire", "?limit=7.9", 7],
    ["ordinaire", "?limit=5", 5],
  ])("limite %s → %i tournois demandés", async (_cas, qs, attendu) => {
    await GET(get(qs as string));
    expect(h.findMany.mock.calls[0][0].take).toBe((attendu as number) + 1);
  });

  it("signale `hasMore` et RETIRE la ligne de trop de la réponse", async () => {
    const ligne = (id: string) => ({
      id,
      name: null,
      date: "2026-11-14",
      status: "draft",
      format: "pools",
      _count: { players: 8 },
    });
    h.findMany.mockResolvedValue([ligne("a"), ligne("b"), ligne("c")]);
    const body = await (await GET(get("?limit=2"))).json();
    expect(body.hasMore).toBe(true);
    expect(body.tournaments.map((t: { id: string }) => t.id)).toEqual(["a", "b"]);
  });

  it("hasMore vaut faux quand la page n'est pas pleine, et n'expose que six champs", async () => {
    h.findMany.mockResolvedValue([
      {
        id: "a",
        name: "Nuit du squash",
        date: "2026-11-14",
        status: "running",
        format: "pools",
        createdById: "u9",
        _count: { players: 8 },
      },
    ]);
    const body = await (await GET(get("?limit=2"))).json();
    expect(body.hasMore).toBe(false);
    // Ni `createdById` ni le roster : la liste est publique à tous les connectés.
    expect(body.tournaments).toEqual([
      {
        id: "a",
        name: "Nuit du squash",
        date: "2026-11-14",
        status: "running",
        format: "pools",
        playerCount: 8,
      },
    ]);
  });
});

describe("POST /api/tournaments — les neuf refus", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    const res = await POST(post(corps()));
    expect(res.status).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(post(corps()))).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("403 pour un compte email seul (sans ResaMania)", async () => {
    // Un tournoi occupe les terrains du club : il faut un compte club derrière.
    h.session = { userId: "u1", resa: null };
    const res = await POST(post(corps()));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Compte email seul : la création de tournoi est réservée aux comptes ResaMania.",
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each([
    ["absente", undefined],
    ["numérique", 20261114],
    ["au format français", "14/11/2026"],
    ["tronquée", "2026-11"],
    ["avec une heure", "2026-11-14T20:00"],
  ])("400 sur une date %s", async (_cas, date) => {
    // `date` est une CHAÎNE en base, et les listes se trient dessus : un format libre casse
    // l'ordre chronologique sans jamais lever d'erreur.
    const res = await POST(post(corps({ date })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Date invalide" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each([[1], [5], [0], ["3"], [null], [3.5]])(
    "400 si le nombre de matchs visé vaut %s",
    async (targetMatches) => {
      const res = await POST(post(corps({ targetMatches })));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Nombre de matchs visé invalide (2, 3 ou 4)",
      });
    },
  );

  it.each([
    ["un joueur de trop peu", MIN_PLAYERS - 1],
    ["un joueur de trop", MAX_PLAYERS + 1],
    ["aucun joueur", 0],
  ])("400 avec %s", async (_cas, n) => {
    const players = Array.from({ length: n as number }, (_, i) => ({ guestName: `J${i}` }));
    const res = await POST(post(corps({ players })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: `Il faut de ${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs`,
    });
  });

  it("400 si `players` n'est pas un tableau", async () => {
    expect((await POST(post(corps({ players: { a: 1 } })))).status).toBe(400);
  });

  it.each([
    ["une chaîne", "Marc"],
    ["null", null],
    ["un objet vide", {}],
    ["un invité au nom blanc", { guestName: "   " }],
    ["un userId vide", { userId: "" }],
  ])("400 sur un joueur %s", async (_cas, mauvais) => {
    const res = await POST(post(corps({ players: avec([mauvais]) })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Joueur invalide" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("400 si le même membre est inscrit deux fois", async () => {
    // Sinon il jouerait contre lui-même : `roundRobin` apparie des index, pas des identités.
    h.users = [{ id: "m1", displayName: "Marc", nickname: null }];
    const players = avec([{ userId: "m1" }, { userId: "m1" }]);
    const res = await POST(post(corps({ players })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Un membre est en double" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("400 si un userId ne correspond à aucun membre", async () => {
    // Deux demandés, un seul trouvé : on refuse tout le tournoi plutôt que d'inscrire un
    // joueur fantôme, qui s'afficherait « ? » sur la feuille de match.
    h.users = [{ id: "m1", displayName: "Marc", nickname: null }];
    const players = avec([{ userId: "m1" }, { userId: "inconnu" }]);
    const res = await POST(post(corps({ players })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Membre inconnu" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("deux INVITÉS homonymes sont acceptés (ce sont deux personnes)", async () => {
    // Le doublon n'est refusé que sur les membres : rien ne dit que deux « Marc » invités
    // soient le même Marc.
    const players = avec([{ guestName: "Marc" }, { guestName: "Marc" }]);
    expect((await POST(post(corps({ players })))).status).toBe(201);
  });
});

describe("POST /api/tournaments — ce qui est écrit quand tout est bon", () => {
  it("201, un identifiant et les formules proposées", async () => {
    const res = await POST(post(corps()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("t-neuf");
    expect(body.proposals.length).toBeGreaterThan(0);
    // Le format enregistré est la PREMIÈRE proposition — celle que l'écran présélectionne.
    expect(cree().format).toBe(body.proposals[0].kind);
  });

  it("naît en brouillon, au nom de son créateur", async () => {
    await POST(post(corps()));
    expect(cree()).toMatchObject({ status: "draft", createdById: "u1", date: "2026-11-14" });
  });

  it("numérote les joueurs dans l'ordre reçu (seed 0, 1, 2…)", async () => {
    // Les seeds pilotent la répartition en poules et la tête de série : les mélanger change
    // le tournoi.
    await POST(post(corps()));
    expect(joueursCrees().map((p) => p.seed)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(joueursCrees().map((p) => p.displayName)).toEqual([
      "J1",
      "J2",
      "J3",
      "J4",
      "J5",
      "J6",
    ]);
  });

  it("fige le nom d'un membre à la création, surnom d'abord", async () => {
    // Figé : si Marc change de surnom en décembre, la feuille de match de novembre ne bouge pas.
    h.users = [
      { id: "m1", displayName: "Marc Dupont", nickname: "Marco" },
      { id: "m2", displayName: "Léa Martin", nickname: null },
    ];
    await POST(post(corps({ players: avec([{ userId: "m1" }, { userId: "m2" }]) })));
    expect(joueursCrees()[0]).toMatchObject({ userId: "m1", displayName: "Marco" });
    expect(joueursCrees()[1]).toMatchObject({ userId: "m2", displayName: "Léa Martin" });
  });

  it("un joueur portant un userId ET un guestName est traité en membre", async () => {
    h.users = [{ id: "m1", displayName: "Marc", nickname: null }];
    await POST(post(corps({ players: avec([{ userId: "m1", guestName: "Imposteur" }]) })));
    expect(joueursCrees()[0]).toMatchObject({ guestName: null, displayName: "Marc" });
  });

  it("rogne les noms trop longs plutôt que de refuser", async () => {
    const players = avec([{ guestName: `  ${"a".repeat(60)}  ` }]);
    await POST(post(corps({ name: `  ${"n".repeat(100)}  `, players })));
    expect(cree().name).toBe("n".repeat(80));
    expect(joueursCrees()[0].guestName).toBe("a".repeat(40));
  });

  it("un nom vide ou blanc devient null, pas une chaîne vide", async () => {
    await POST(post(corps({ name: "   " })));
    expect(cree().name).toBeNull();
  });

  it.each([
    ["absent", undefined, 3],
    ["3", 3, 3],
    ["5", 5, 5],
    ["4, inconnu", 4, 3],
    ["la chaîne « 5 »", "5", 3],
  ])("bestOf %s → %i", async (_cas, bestOf, attendu) => {
    await POST(post(corps({ bestOf })));
    expect(cree().bestOf).toBe(attendu);
  });

  it.each([
    ["absent", undefined, 2],
    ["0", 0, 2],
    ["9", 9, 2],
    ["1", 1, 1],
    ["8", 8, 8],
    ["3.7", 3.7, 3],
  ])("courts %s → %i", async (_cas, courts, attendu) => {
    // Le nombre de terrains ne change pas le tableau, mais il change l'ordre de passage et la
    // durée estimée annoncée au créateur.
    await POST(post(corps({ courts })));
    expect(cree().courts).toBe(attendu);
  });

  it("un corps illisible est refusé comme un corps vide, sans planter", async () => {
    const req = {
      cookies: { get: () => undefined },
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as NextRequest;
    expect((await POST(req)).status).toBe(400);
  });
});
