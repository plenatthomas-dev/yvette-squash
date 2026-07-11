import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  winGames,
  validScore,
  serializeTournament,
  materialize,
  materializeFinals,
  type FullTournament,
} from "./tournament-db";

// --- Fabriques de FullTournament mockés (formes Prisma minimales mais complètes) ---------

type P = FullTournament["players"][number];
type G = FullTournament["groups"][number];
type M = FullTournament["matches"][number];

function player(over: Partial<P> & { id: string }): P {
  return {
    tournamentId: "t1",
    userId: over.id, // par défaut un membre (userId = id), suffisant pour isParticipant
    guestName: null,
    displayName: over.id,
    seed: 0,
    groupId: null,
    ...over,
  } as P;
}

function group(id: string, label: string): G {
  return { id, tournamentId: "t1", label } as G;
}

function match(over: Partial<M> & { id: string; phase: string }): M {
  return {
    tournamentId: "t1",
    groupId: null,
    tier: null,
    round: null,
    slot: null,
    branch: null,
    placeLabel: null,
    player1Id: null,
    player2Id: null,
    score1: null,
    score2: null,
    winnerId: null,
    status: "pending",
    courtName: null,
    order: null,
    nextWinMatchId: null,
    nextWinSlot: null,
    nextLoseMatchId: null,
    nextLoseSlot: null,
    ...over,
  } as M;
}

function tournament(over: Partial<FullTournament> & Pick<FullTournament, "format">): FullTournament {
  return {
    id: "t1",
    name: null,
    date: "2026-07-11",
    createdById: "creator",
    status: "running",
    targetMatches: 3,
    bestOf: 3,
    courts: 2,
    createdAt: new Date(),
    players: [],
    groups: [],
    matches: [],
    ...over,
  } as FullTournament;
}

// Un match de poule « joué » (score en jeux). p1 gagne si games1 > games2.
function poolResult(
  id: string,
  groupId: string,
  p1: string,
  p2: string,
  games1: number,
  games2: number,
): M {
  return match({
    id,
    phase: "pool",
    groupId,
    player1Id: p1,
    player2Id: p2,
    score1: games1,
    score2: games2,
    winnerId: games1 > games2 ? p1 : p2,
    status: "done",
  });
}

describe("winGames / validScore", () => {
  it("bo3 → 2 jeux gagnants, bo5 → 3", () => {
    expect(winGames(3)).toBe(2);
    expect(winGames(5)).toBe(3);
  });
  it("valide un score seulement si un camp atteint winGames et l'autre est en dessous", () => {
    expect(validScore(2, 0, 3)).toBe(true);
    expect(validScore(2, 1, 3)).toBe(true);
    expect(validScore(1, 1, 3)).toBe(false); // personne n'a gagné
    expect(validScore(2, 2, 3)).toBe(false); // deux vainqueurs
    expect(validScore(3, 1, 3)).toBe(false); // 3 jeux hors bo3
    expect(validScore(3, 2, 5)).toBe(true);
    expect(validScore(-1, 2, 3)).toBe(false);
  });
});

describe("serializeTournament — poules", () => {
  // Poule unique de 3 : p0 bat p1 (2-0) et p2 (2-1) ; p1 bat p2 (2-0).
  const players = [
    player({ id: "p0", displayName: "Alice", seed: 0 }),
    player({ id: "p1", displayName: "Bob", seed: 1 }),
    player({ id: "p2", displayName: "Chloé", seed: 2 }),
  ].map((p) => ({ ...p, groupId: "gA" }));
  const base = tournament({
    format: "pools",
    players,
    groups: [group("gA", "A")],
    matches: [
      poolResult("m01", "gA", "p0", "p1", 2, 0),
      poolResult("m02", "gA", "p0", "p2", 2, 1),
      poolResult("m12", "gA", "p1", "p2", 2, 0),
    ],
  });

  it("classement MJ/V/D correct et champion = 1er de l'unique poule", () => {
    const v = serializeTournament(base, "p0");
    expect(v.pools).not.toBeNull();
    const st = v.pools![0].standings;
    expect(st.map((s) => s.name)).toEqual(["Alice", "Bob", "Chloé"]);
    expect(st[0]).toMatchObject({ name: "Alice", played: 2, wins: 2, losses: 0 });
    expect(st[1]).toMatchObject({ name: "Bob", played: 2, wins: 1, losses: 1 });
    expect(st[2]).toMatchObject({ name: "Chloé", played: 2, wins: 0, losses: 2 });
    expect(v.champion).toMatchObject({ id: "p0", name: "Alice" });
    expect(v.status).toBe("done");
  });

  it("statut « running » tant qu'un match n'est pas joué, pas de champion", () => {
    const t = { ...base, matches: [base.matches[0], base.matches[1], match({ id: "m12", phase: "pool", groupId: "gA", player1Id: "p1", player2Id: "p2" })] };
    const v = serializeTournament(t, "p0");
    expect(v.status).toBe("running");
    expect(v.champion).toBeNull();
  });

  it("statut « draft » conservé avant génération", () => {
    const v = serializeTournament({ ...base, status: "draft" }, "p0");
    expect(v.status).toBe("draft");
  });

  it("isParticipant / isCreator", () => {
    expect(serializeTournament(base, "p1")).toMatchObject({ isParticipant: true, isCreator: false });
    expect(serializeTournament(base, "creator")).toMatchObject({ isCreator: true, isParticipant: false });
    expect(serializeTournament(base, "étranger")).toMatchObject({ isParticipant: false, isCreator: false });
  });
});

describe("serializeTournament — poules entrelacées (2 poules jouées en parallèle)", () => {
  it("les premiers matchs planifiés proviennent de poules différentes", () => {
    const mk = (grp: string, ids: string[]) =>
      ids.map((id) => ({ ...player({ id, displayName: id, seed: 0 }), groupId: grp }));
    const players = [...mk("gA", ["a0", "a1", "a2"]), ...mk("gB", ["b0", "b1", "b2"])];
    const matches = [
      // Poule A (ordre round-robin)
      poolResult("A0", "gA", "a0", "a1", 2, 0),
      poolResult("A1", "gA", "a0", "a2", 2, 0),
      poolResult("A2", "gA", "a1", "a2", 2, 0),
      // Poule B
      poolResult("B0", "gB", "b0", "b1", 2, 0),
      poolResult("B1", "gB", "b0", "b2", 2, 0),
      poolResult("B2", "gB", "b1", "b2", 2, 0),
    ];
    const t = tournament({
      format: "pools",
      courts: 2,
      players,
      groups: [group("gA", "A"), group("gB", "B")],
      matches,
    });
    const v = serializeTournament(t, "a0");
    const all = v.pools!.flatMap((p) => p.matches.map((m) => ({ ...m, pool: p.label })));
    const ordered = all.filter((m) => m.order !== null).sort((x, y) => x.order! - y.order!);
    // Les 2 premiers passages (une « vague » de 2 terrains) mélangent les deux poules.
    const firstWave = new Set(ordered.slice(0, 2).map((m) => m.pool));
    expect(firstWave).toEqual(new Set(["A", "B"]));
  });
});

describe("serializeTournament — tableau (bracket)", () => {
  // n=4, tout joué : seed0 champion, seed3 dernier. Clés = branch-round-slot.
  const players = [0, 1, 2, 3].map((s) =>
    player({ id: `s${s}`, displayName: `S${s}`, seed: s }),
  );
  const won = (id: string, phase: string, branch: string, round: number, slot: number, p1: string, p2: string, winner: string, placeLabel?: string) =>
    match({ id, phase, branch, round, slot, player1Id: p1, player2Id: p2, score1: winner === p1 ? 2 : 0, score2: winner === p2 ? 2 : 0, winnerId: winner, status: "done", placeLabel: placeLabel ?? null });
  const base = tournament({
    format: "bracket",
    players,
    matches: [
      // seedOrder(4) = [0,3,1,2] → M-0-0 = s0 vs s3 ; M-0-1 = s1 vs s2
      won("d1", "winners", "M", 0, 0, "s0", "s3", "s0"),
      won("d2", "winners", "M", 0, 1, "s1", "s2", "s1"),
      won("f", "winners", "MW", 1, 0, "s0", "s1", "s0", "Finale"),
      won("p", "classification", "ML", 1, 0, "s3", "s2", "s2", "Petite finale (3e-4e place)"),
    ],
  });

  it("classement final avec MJ/V/D par joueur et champion", () => {
    const v = serializeTournament(base, "s0");
    expect(v.bracket).not.toBeNull();
    const r = v.bracket!.ranking!;
    expect(r.map((x) => x.name)).toEqual(["S0", "S1", "S2", "S3"]);
    expect(r[0]).toMatchObject({ name: "S0", rank: 1, played: 2, wins: 2, losses: 0 });
    expect(r[1]).toMatchObject({ name: "S1", rank: 2, played: 2, wins: 1, losses: 1 });
    expect(r[2]).toMatchObject({ name: "S2", rank: 3, played: 2, wins: 1, losses: 1 });
    expect(r[3]).toMatchObject({ name: "S3", rank: 4, played: 2, wins: 0, losses: 2 });
    expect(v.champion).toMatchObject({ id: "s0", name: "S0" });
    expect(v.status).toBe("done");
  });

  it("statut « running » tant que le classement n'est pas complet", () => {
    const t = { ...base, matches: base.matches.filter((m) => m.id !== "f" && m.id !== "p") };
    const v = serializeTournament(t, "s0");
    expect(v.bracket!.ranking).toBeNull();
    expect(v.status).toBe("running");
  });
});

// --- materialize : fausse TransactionClient qui capture les écritures -------------------

function fakeTx() {
  const groups: { id: string; label: string }[] = [];
  const playerGroups: Record<string, string> = {};
  const matches: Partial<M>[] = [];
  let seq = 0;
  const tx = {
    tournamentGroup: {
      create: async ({ data }: { data: { label: string } }) => {
        const g = { id: `grp${seq++}`, label: data.label };
        groups.push(g);
        return g;
      },
    },
    tournamentPlayer: {
      update: async ({ where, data }: { where: { id: string }; data: { groupId: string } }) => {
        playerGroups[where.id] = data.groupId;
        return {};
      },
    },
    match: {
      create: async ({ data }: { data: Partial<M> }) => {
        matches.push(data);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, groups, playerGroups, matches };
}

describe("materialize", () => {
  it("poules : crée les groupes, répartit en serpentin, génère les round-robins", async () => {
    const players = [0, 1, 2, 3, 4, 5].map((s) => ({ id: `p${s}`, seed: s }));
    const f = fakeTx();
    await materialize(f.tx, "t1", "pools", players, [3, 3]);
    expect(f.groups.map((g) => g.label)).toEqual(["A", "B"]);
    // 2 poules de 3 → 3 matchs chacune = 6 matchs de poule.
    expect(f.matches.length).toBe(6);
    expect(f.matches.every((m) => m.phase === "pool")).toBe(true);
    // Serpentin (snakeGroups(6,2)) : poule A = seeds {0,3,4}, poule B = {1,2,5}.
    const poolA = Object.entries(f.playerGroups).filter(([, g]) => g === f.groups[0].id).map(([id]) => id);
    expect(new Set(poolA)).toEqual(new Set(["p0", "p3", "p4"]));
  });

  it("tableau : crée un match par match structurel, byes résolus", async () => {
    const players = [0, 1, 2, 3].map((s) => ({ id: `s${s}`, seed: s }));
    const f = fakeTx();
    await materialize(f.tx, "t1", "bracket", players, []);
    // placementBracket(4) = 4 matchs (2 au 1er tour + finale + petite finale), aucun bye.
    expect(f.matches.length).toBe(4);
    expect(f.matches.some((m) => m.placeLabel === "Finale")).toBe(true);
    expect(f.matches.every((m) => m.status !== "bye")).toBe(true);
  });

  it("tableau avec byes : n=6 → byes matérialisés (statut bye, un seul joueur)", async () => {
    const players = [0, 1, 2, 3, 4, 5].map((s) => ({ id: `s${s}`, seed: s }));
    const f = fakeTx();
    await materialize(f.tx, "t1", "bracket", players, []);
    const byes = f.matches.filter((m) => m.status === "bye");
    expect(byes.length).toBe(2); // P=8, 2 byes
    for (const b of byes) expect(b.player1Id === null || b.player2Id === null).toBe(true);
  });
});

// --- pools_bracket : phase finale par rang de poule -------------------------------------

// Fake tx pour materializeFinals : findUnique renvoie le tournoi mocké, create capture.
function fakeTxTournament(t: FullTournament) {
  const created: Partial<M>[] = [];
  const tx = {
    tournament: { findUnique: async () => t },
    match: {
      create: async ({ data }: { data: Partial<M> }) => {
        created.push(data);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, created };
}

describe("pools_bracket", () => {
  // 2 poules de 3, TOUTES jouées. Poule A : a0>a1>a2 ; Poule B : b0>b1>b2.
  const mkPools = (): FullTournament => {
    const players = [
      ...["a0", "a1", "a2"].map((id, i) => ({ ...player({ id, seed: i }), groupId: "gA" })),
      ...["b0", "b1", "b2"].map((id, i) => ({ ...player({ id, seed: i + 3 }), groupId: "gB" })),
    ];
    return tournament({
      format: "pools_bracket",
      players,
      groups: [group("gA", "A"), group("gB", "B")],
      matches: [
        poolResult("A01", "gA", "a0", "a1", 2, 0),
        poolResult("A02", "gA", "a0", "a2", 2, 0),
        poolResult("A12", "gA", "a1", "a2", 2, 0),
        poolResult("B01", "gB", "b0", "b1", 2, 0),
        poolResult("B02", "gB", "b0", "b2", 2, 0),
        poolResult("B12", "gB", "b1", "b2", 2, 0),
      ],
    });
  };

  it("poules finies → canGenerateFinals, pas encore « done »", () => {
    const v = serializeTournament(mkPools(), "creator");
    expect(v.canGenerateFinals).toBe(true);
    expect(v.finals).toBeNull();
    expect(v.status).toBe("running");
    expect(v.champion).toBeNull();
  });

  it("materializeFinals : un tableau par rang (1ers, 2es, 3es), participants croisés", async () => {
    const f = fakeTxTournament(mkPools());
    const tiers = await materializeFinals(f.tx, "t1");
    expect(tiers).toBe(3);
    // 3 tiers de 2 joueurs → 1 finale chacun.
    expect(f.created.length).toBe(3);
    expect(f.created.map((m) => m.tier).sort()).toEqual([1, 2, 3]);
    const t1 = f.created.find((m) => m.tier === 1)!;
    expect(new Set([t1.player1Id, t1.player2Id])).toEqual(new Set(["a0", "b0"]));
    const t2 = f.created.find((m) => m.tier === 2)!;
    expect(new Set([t2.player1Id, t2.player2Id])).toEqual(new Set(["a1", "b1"]));
  });

  it("sérialise les tableaux finaux + champion = vainqueur du tier 1", () => {
    const base = mkPools();
    // Matchs de finale tels que materializeFinals les crée (tier 1-3), tier 1 & 2 joués.
    const finals = [
      match({ id: "F1", phase: "winners", tier: 1, round: 0, slot: 0, branch: "M", placeLabel: "Finale", player1Id: "a0", player2Id: "b0", status: "done", score1: 2, score2: 1, winnerId: "a0" }),
      match({ id: "F2", phase: "winners", tier: 2, round: 0, slot: 0, branch: "M", placeLabel: "Finale", player1Id: "a1", player2Id: "b1", status: "done", score1: 2, score2: 0, winnerId: "a1" }),
      match({ id: "F3", phase: "winners", tier: 3, round: 0, slot: 0, branch: "M", placeLabel: "Finale", player1Id: "a2", player2Id: "b2", status: "pending" }),
    ];
    const v = serializeTournament({ ...base, matches: [...base.matches, ...finals] }, "creator");
    expect(v.finals).not.toBeNull();
    expect(v.finals!.map((f) => f.tier)).toEqual([1, 2, 3]);
    expect(v.finals!.every((f) => f.matches.length === 1)).toBe(true);
    expect(v.champion).toMatchObject({ id: "a0" });
    expect(v.canGenerateFinals).toBe(false); // finale déjà générée
    expect(v.status).toBe("running"); // tier 3 pas joué
  });
});
