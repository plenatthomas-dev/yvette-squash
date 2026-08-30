import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

type Match = Record<string, unknown>;
type View = {
  isParticipant: boolean;
  isCreator: boolean;
  players: { id: string }[];
  pools: { matches: Match[] }[] | null;
  bracket: { matches: Match[] } | null;
  finals?: { matches: Match[] }[] | null;
  status: string;
};

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  tournament: null as null | Record<string, unknown>,
  view: {} as View,
  matchUpdate: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
  matchUpdateMany: vi.fn(
    async (_args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => ({
      count: 0,
    }),
  ),
  tournamentUpdate: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
  txOptions: undefined as unknown,
}));

// Le flag est résolu à chaud côté serveur (env + override en base) : on mocke l'état effectif.
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
    // Exécute la callback de transaction avec un faux tx (propage les throws → catch route).
    //
    // Ce faux client N'APPLIQUE aucune isolation : il exécute la callback telle quelle. Ce que
    // la concurrence réelle donne se mesure ailleurs, sur une vraie base (cf.
    // `tournament-generate.pg.test.ts`). Ici on éprouve la LOGIQUE : qui a le droit d'écrire,
    // ce qui est écrit, et ce que la cascade efface.
    //
    // Il RETIENT en revanche le second argument. Sans cela, remplacer `serializableTransaction`
    // par un `prisma.$transaction` nu ne changerait rien à ce fichier — et la garde qui empêche
    // deux saisies simultanées de se recouvrir tomberait sans qu'un test bronche.
    $transaction: (fn: (tx: unknown) => unknown, options?: unknown) => {
      h.txOptions = options;
      return Promise.resolve(
        fn({
          tournament: { findUnique: async () => h.tournament, update: h.tournamentUpdate },
          match: { update: h.matchUpdate, updateMany: h.matchUpdateMany },
        }),
      );
    },
  },
}));
// On garde validScore/tournamentInclude RÉELS ; on ne contrôle que serializeTournament.
vi.mock("@/lib/tournament-db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tournament-db")>("@/lib/tournament-db");
  return { ...actual, serializeTournament: () => h.view };
});

import { PATCH } from "./route";

const req = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const params = Promise.resolve({ id: "t1", mid: "m1" });

// Vue « poule » par défaut : 1 match jouable m1 entre p1 et p2, l'utilisateur est participant.
function poolView(over: Partial<View> = {}, match: Match = {}): View {
  return {
    isParticipant: true,
    isCreator: false,
    players: [{ id: "p1" }, { id: "p2" }],
    pools: [
      {
        matches: [
          { id: "m1", p1: { id: "p1" }, p2: { id: "p2" }, status: "pending", winnerId: null, ...match },
        ],
      },
    ],
    bracket: null,
    status: "running",
    ...over,
  };
}

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.tournament = { bestOf: 3, status: "running", matches: [] };
  h.view = poolView();
  h.txOptions = undefined;
  h.matchUpdate.mockClear();
  h.matchUpdateMany.mockClear();
  h.tournamentUpdate.mockClear();
});

describe("PATCH /api/tournaments/[id]/matches/[mid]", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(401);
  });

  it("400 si le score n'est pas numérique", async () => {
    const res = await PATCH(req({ score1: "2", score2: 0 }), { params });
    expect(res.status).toBe(400);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("403 si l'utilisateur n'est ni participant ni créateur", async () => {
    h.view = poolView({ isParticipant: false, isCreator: false });
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(403);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("400 si le score est illégal pour le format (2-2 en bo3)", async () => {
    const res = await PATCH(req({ score1: 2, score2: 2 }), { params });
    expect(res.status).toBe(400);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("404 si le match est introuvable dans la vue", async () => {
    h.view = poolView({ pools: [{ matches: [] }] });
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(404);
  });

  it("400 sur un match « bye »", async () => {
    h.view = poolView({}, { status: "bye" });
    expect((await PATCH(req({ score1: 2, score2: 0 }), { params })).status).toBe(400);
  });

  it("409 si le match est déjà saisi et que l'utilisateur n'est pas le créateur", async () => {
    h.view = poolView({}, { status: "done", winnerId: "p1" });
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(409);
    expect(h.matchUpdate).not.toHaveBeenCalled();
  });

  it("enregistre un score valide (participant) : winnerId = camp gagnant", async () => {
    const res = await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdate).toHaveBeenCalledTimes(1);
    const arg = h.matchUpdate.mock.calls[0][0];
    expect(arg.where.id).toBe("m1");
    expect(arg.data).toMatchObject({ winnerId: "p1", status: "done" });
  });

  it("saisit en isolation Serializable, pas dans une transaction ordinaire", async () => {
    // Relecture, écriture, cascade et statut doivent former un seul tout : deux saisies
    // simultanées sur le même tableau se recouvriraient sinon en silence.
    await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(h.txOptions).toMatchObject({ isolationLevel: "Serializable" });
  });

  it("le créateur peut corriger un match déjà saisi", async () => {
    h.view = poolView({ isCreator: true }, { status: "done", winnerId: "p1" });
    const res = await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LA CASCADE D'INVALIDATION — ce que corriger un vainqueur efface en aval.
//
// La route l'écrit en toutes lettres : « corriger un match de TABLEAU en changeant le vainqueur
// change les participants de tous les matchs en aval → leurs scores déjà saisis sont caducs ».
//
// Rien ne le vérifiait. Les onze tests ci-dessus travaillent TOUS sur une vue « poule »
// (`bracket: null`, pas de `finals`) : `bracketMatch` et `finalMatch` y valent toujours null,
// donc le bloc entier était mort en test. `matchUpdateMany` et `tournamentUpdate` étaient
// déclarés, câblés, remis à zéro — et jamais assertés : deux espions muets qui n'existaient que
// pour empêcher le faux client de planter. On pouvait supprimer la cascade ET la réécriture du
// statut sans faire rougir un seul test.
//
// Tableau de 4 joueurs (`placementBracket(4)`) : deux matchs au 1er tour (M-0-0, M-0-1), puis
// la finale (MW-1-0) et la petite finale (ML-1-0). Les DEUX descendent de M-0-0 — l'une par le
// vainqueur, l'autre par le perdant. C'est là tout l'intérêt du repêchage : personne n'étant
// éliminé, une correction se propage des deux côtés.

/** Une ligne DB de match de tableau, telle que `t.matches` la porte. */
function ligne(id: string, branch: string, round: number, slot: number, over: Match = {}): Match {
  return {
    id,
    branch,
    round,
    slot,
    tier: null,
    phase: branch.includes("L") ? "classification" : "winners",
    status: "pending",
    winnerId: null,
    score1: null,
    score2: null,
    player1Id: null,
    player2Id: null,
    ...over,
  };
}

const JOUE = (gagnant: string, perdant: string) => ({
  status: "done",
  winnerId: gagnant,
  score1: 2,
  score2: 0,
  player1Id: gagnant,
  player2Id: perdant,
});

/** Tableau autonome de 4 : m1 est M-0-0 (déjà joué), la finale et la petite finale aussi. */
function bracketDb(): Match[] {
  return [
    ligne("m1", "M", 0, 0, JOUE("p1", "p2")),
    ligne("m2", "M", 0, 1, JOUE("p3", "p4")),
    ligne("m3", "MW", 1, 0, JOUE("p1", "p3")), // finale : p1 champion
    ligne("m4", "ML", 1, 0, JOUE("p2", "p4")), // petite finale
  ];
}

function bracketView(over: Partial<View> = {}): View {
  return {
    isParticipant: true,
    isCreator: true, // corriger un match déjà saisi est réservé au créateur
    players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }],
    pools: null,
    bracket: {
      matches: [
        { id: "m1", p1: { id: "p1" }, p2: { id: "p2" }, status: "done", winnerId: "p1" },
        { id: "m2", p1: { id: "p3" }, p2: { id: "p4" }, status: "done", winnerId: "p3" },
        { id: "m3", p1: { id: "p1" }, p2: { id: "p3" }, status: "done", winnerId: "p1" },
        { id: "m4", p1: { id: "p2" }, p2: { id: "p4" }, status: "done", winnerId: "p2" },
      ],
    },
    status: "running",
    ...over,
  };
}

/** Les identifiants passés au dernier `updateMany`, triés (l'ordre du filtre ne compte pas). */
const remisAJouer = () =>
  [...(h.matchUpdateMany.mock.calls[0]?.[0].where.id.in ?? [])].sort();

describe("PATCH — la cascade d'invalidation du tableau", () => {
  beforeEach(() => {
    h.tournament = { bestOf: 3, status: "running", matches: bracketDb() };
    h.view = bracketView();
  });

  it("changer le vainqueur du 1er tour remet à jouer la finale ET la petite finale", async () => {
    // p2 gagne finalement M-0-0 : p1 n'est plus en finale, p2 n'est plus en petite finale.
    // Les deux résultats en aval portent sur des joueurs qui n'y sont plus — ils sont caducs.
    const res = await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdateMany).toHaveBeenCalledTimes(1);
    expect(remisAJouer()).toEqual(["m3", "m4"]);
  });

  it("vide AUSSI les participants et les scores, pas seulement le statut", async () => {
    // Laisser player1Id/player2Id en place figerait les anciens joueurs dans le match suivant :
    // `bracketLive` les re-résout depuis les vainqueurs, encore faut-il que les slots soient
    // libres. Un statut « pending » sur d'anciens participants est pire qu'un match faux :
    // c'est un match faux qui a l'air jouable.
    await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(h.matchUpdateMany.mock.calls[0][0].data).toEqual({
      status: "pending",
      winnerId: null,
      score1: null,
      score2: null,
      player1Id: null,
      player2Id: null,
    });
  });

  it("ne touche à rien si le vainqueur ne change pas (simple correction de score)", async () => {
    // 2-0 corrigé en 2-1 : p1 gagne toujours, l'aval reste valable. Invalider ici ferait
    // resaisir deux matchs pour une faute de frappe.
    const res = await PATCH(req({ score1: 2, score2: 1 }), { params });
    expect(res.status).toBe(200);
    expect(h.matchUpdateMany).not.toHaveBeenCalled();
  });

  it("ne touche à rien sur une PREMIÈRE saisie (aucun vainqueur précédent)", async () => {
    h.tournament = {
      bestOf: 3,
      status: "running",
      matches: [ligne("m1", "M", 0, 0), ...bracketDb().slice(1)],
    };
    h.view = bracketView({
      bracket: {
        matches: [
          { id: "m1", p1: { id: "p1" }, p2: { id: "p2" }, status: "pending", winnerId: null },
        ],
      },
    });
    await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(h.matchUpdateMany).not.toHaveBeenCalled();
  });

  it("n'invalide jamais un match déjà en attente (rien à effacer)", async () => {
    // La finale n'a pas encore été jouée : elle est déjà « pending », l'inscrire dans le
    // `updateMany` serait une écriture pour rien. Seule la petite finale est concernée.
    h.tournament = {
      bestOf: 3,
      status: "running",
      matches: [
        ligne("m1", "M", 0, 0, JOUE("p1", "p2")),
        ligne("m2", "M", 0, 1, JOUE("p3", "p4")),
        ligne("m3", "MW", 1, 0), // pas encore jouée
        ligne("m4", "ML", 1, 0, JOUE("p2", "p4")),
      ],
    };
    await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(remisAJouer()).toEqual(["m4"]);
  });

  it("épargne les byes, qu'aucune correction ne rend rejouables", async () => {
    // Un bye n'est pas un match : le remettre « pending » créerait un match fantôme à un seul
    // joueur, que personne ne peut jouer et qui bloquerait le tournoi en « running ».
    h.tournament = {
      bestOf: 3,
      status: "running",
      matches: [
        ligne("m1", "M", 0, 0, JOUE("p1", "p2")),
        ligne("m2", "M", 0, 1, JOUE("p3", "p4")),
        ligne("m3", "MW", 1, 0, { ...JOUE("p1", "p3"), status: "bye" }),
        ligne("m4", "ML", 1, 0, JOUE("p2", "p4")),
      ],
    };
    await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(remisAJouer()).toEqual(["m4"]);
  });

  it("corriger une POULE ne remet à jouer aucun match de tableau final", async () => {
    // Les poules n'ont pas d'aval : chaque match y est indépendant, seul le classement bouge —
    // et un tableau final déjà joué ne se rejoue pas parce qu'on a corrigé une faute de frappe
    // en phase de poules. `materialize` ne donne d'ailleurs ni branch ni round ni slot à un
    // match de poule : il n'a pas de place dans un arbre.
    h.view = poolView({ isCreator: true }, { status: "done", winnerId: "p1" });
    h.tournament = {
      bestOf: 3,
      status: "running",
      matches: [
        { id: "m1", branch: null, round: null, slot: null, tier: null, phase: "pool", status: "done", winnerId: "p1", score1: 2, score2: 0, player1Id: "p1", player2Id: "p2" },
        ligne("f-w", "MW", 1, 0, { ...JOUE("p1", "p3"), tier: 1 }),
      ],
    };
    await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(h.matchUpdateMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LA CASCADE DANS UN TABLEAU FINAL — et la frontière entre les tiers.
//
// En « poules + tableau final », il y a UN tableau par rang de poule, et ils portent tous les
// MÊMES clés (`M-0-0`, `MW-1-0`…) : c'est le champ `tier` qui les sépare. Le filtre de reset le
// dit — « borné à SON tier ». Sans cette borne, corriger la finale des 1ers effacerait la
// finale des 2es, entre d'autres joueurs, qui n'a rien à voir.

describe("PATCH — la cascade d'un tableau final reste dans son tier", () => {
  beforeEach(() => {
    // Deux tiers de 4 joueurs, clés identiques, résultats identiques. Seul `tier` diffère.
    const tier = (n: number, ids: string[]) => [
      ligne(`t${n}-a`, "M", 0, 0, { ...JOUE(ids[0], ids[1]), tier: n }),
      ligne(`t${n}-b`, "M", 0, 1, { ...JOUE(ids[2], ids[3]), tier: n }),
      ligne(`t${n}-w`, "MW", 1, 0, { ...JOUE(ids[0], ids[2]), tier: n }),
      ligne(`t${n}-l`, "ML", 1, 0, { ...JOUE(ids[1], ids[3]), tier: n }),
    ];
    h.tournament = {
      bestOf: 3,
      status: "running",
      matches: [
        ...tier(1, ["a1", "a2", "a3", "a4"]),
        ...tier(2, ["b1", "b2", "b3", "b4"]),
      ],
    };
    h.view = {
      isParticipant: true,
      isCreator: true,
      players: [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }],
      pools: [{ matches: [] }],
      bracket: null,
      finals: [
        {
          matches: [
            { id: "t1-a", p1: { id: "a1" }, p2: { id: "a2" }, status: "done", winnerId: "a1" },
          ],
        },
        {
          matches: [
            { id: "t2-a", p1: { id: "b1" }, p2: { id: "b2" }, status: "done", winnerId: "b1" },
          ],
        },
      ],
      status: "running",
    };
  });

  it("corriger le tableau des 1ers n'efface RIEN dans celui des 2es", async () => {
    const res = await PATCH(req({ score1: 0, score2: 2 }), {
      params: Promise.resolve({ id: "t1", mid: "t1-a" }),
    });
    expect(res.status).toBe(200);
    // Les deux matchs en aval DU MÊME tier, et eux seuls.
    expect(remisAJouer()).toEqual(["t1-l", "t1-w"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LE STATUT RÉÉCRIT APRÈS COUP — dans les deux sens.
//
// « Statut effectif recalculé APRÈS mutation (bidirectionnel : la cascade a pu ré-ouvrir un
// tournoi terminé). » L'affirmation est double, et aucune de ses deux moitiés n'était vérifiée.

describe("PATCH — le statut figé après la mutation", () => {
  it("fige « done » quand la saisie termine le tournoi", async () => {
    h.tournament = { bestOf: 3, status: "running", matches: [] };
    h.view = poolView({ status: "done" });
    await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(h.tournamentUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "done" },
    });
  });

  it("REVIENT à « running » quand une correction ré-ouvre un tournoi terminé", async () => {
    // C'est la moitié que personne ne regarde : sans elle, la liste continue d'afficher
    // « Terminé » un tournoi dont la cascade vient de rouvrir deux matchs.
    h.tournament = { bestOf: 3, status: "done", matches: [] };
    h.view = poolView({ isCreator: true, status: "running" }, { status: "done", winnerId: "p1" });
    await PATCH(req({ score1: 0, score2: 2 }), { params });
    expect(h.tournamentUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "running" },
    });
  });

  it("n'écrit rien quand le statut ne change pas", async () => {
    h.tournament = { bestOf: 3, status: "running", matches: [] };
    h.view = poolView({ status: "running" });
    await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(h.tournamentUpdate).not.toHaveBeenCalled();
  });

  it("ne redescend JAMAIS un tournoi en « draft »", async () => {
    // « draft » signifie « pas encore généré ». Y ramener un tournoi dont on vient de saisir un
    // score ferait disparaître ses poules de l'écran. D'où la garde `eff === done || running`.
    h.tournament = { bestOf: 3, status: "running", matches: [] };
    h.view = poolView({ status: "draft" });
    await PATCH(req({ score1: 2, score2: 0 }), { params });
    expect(h.tournamentUpdate).not.toHaveBeenCalled();
  });
});
