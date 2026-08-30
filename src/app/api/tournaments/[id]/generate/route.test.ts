import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// La concurrence de cette route se mesure sur une vraie base (`tournament-generate.pg.test.ts`).
// Ici on éprouve ce qu'un faux client suffit à montrer : QUI a le droit de générer, et surtout
// AVEC QUELLE RÉPARTITION. Le second point est le plus discret des deux — `materialize` répartit
// toujours en poules équilibrées (`snakeGroups` ne lit que le NOMBRE de poules), donc un
// `poolSizes: [6, 2]` accepté ne produirait pas deux poules de 6 et 2 : il produirait deux poules
// de 4, sans le dire. Le créateur croirait avoir choisi.

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  tournament: null as null | Record<string, unknown>,
  /** Non nul = on force ce que `proposeFormats` renvoie, pour éprouver le repli. */
  propositions: null as null | unknown[],
  txOptions: undefined as unknown,
  // Signature variadique : `materialize` prend six arguments, et ce sont ses 4e et 5e
  // (joueurs, tailles de poules) que ce fichier inspecte.
  materialize: vi.fn(async (..._args: unknown[]) => {}),
  update: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
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
    // On RETIENT les options : c'est la seule chose qui distingue ici une transaction
    // Serializable d'une transaction ordinaire, et c'est tout l'enjeu de la route.
    $transaction: (fn: (tx: unknown) => unknown, options?: unknown) => {
      h.txOptions = options;
      return Promise.resolve(
        fn({ tournament: { findUnique: async () => h.tournament, update: h.update } }),
      );
    },
  },
}));
vi.mock("@/lib/tournament-db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tournament-db")>("@/lib/tournament-db");
  return { ...actual, materialize: h.materialize };
});
vi.mock("@/lib/tournament", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tournament")>("@/lib/tournament");
  return {
    ...actual,
    proposeFormats: (...args: Parameters<typeof actual.proposeFormats>) =>
      h.propositions ?? actual.proposeFormats(...args),
  };
});

import { POST } from "./route";
import { proposeFormats } from "@/lib/tournament";

const req = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: "t1" }) };

/** Un brouillon de `n` joueurs appartenant à `u1`, seeds 0..n-1. */
const brouillon = (n = 8, over: Record<string, unknown> = {}) => ({
  id: "t1",
  createdById: "u1",
  status: "draft",
  targetMatches: 3,
  courts: 2,
  players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, seed: i })),
  ...over,
});

/** Les tailles de poules réellement transmises à `materialize`. */
const tailles = () => h.materialize.mock.calls[0][4] as number[];

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.tournament = brouillon();
  h.propositions = null;
  h.txOptions = undefined;
  h.materialize.mockClear();
  h.update.mockClear();
});

describe("POST /api/tournaments/[id]/generate — qui, et quand", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await POST(req({ kind: "pools" }), params)).status).toBe(404);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req({ kind: "pools" }), params)).status).toBe(401);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it.each([
    ["absente", undefined],
    ["inconnue", "swiss"],
    ["nulle", null],
    ["numérique", 1],
  ])("400 sur une formule %s", async (_cas, kind) => {
    const res = await POST(req({ kind }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Formule non prise en charge" });
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("un corps illisible est refusé en 400, sans planter", async () => {
    const mauvais = {
      cookies: { get: () => undefined },
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as NextRequest;
    expect((await POST(mauvais, params)).status).toBe(400);
  });

  it("404 si le tournoi n'existe pas", async () => {
    h.tournament = null;
    const res = await POST(req({ kind: "pools" }), params);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Tournoi introuvable" });
  });

  it("403 pour un participant qui n'est pas le créateur", async () => {
    h.session = { userId: "u2" };
    const res = await POST(req({ kind: "pools" }), params);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Seul le créateur peut générer le tableau",
    });
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it.each([["running"], ["done"]])("409 si le tournoi est déjà en « %s »", async (status) => {
    h.tournament = brouillon(8, { status });
    const res = await POST(req({ kind: "pools" }), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Tournoi déjà généré" });
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("génère en isolation Serializable, pas dans une transaction ordinaire", async () => {
    // C'est le niveau d'isolation, et lui seul, qui empêche deux clics simultanés de
    // matérialiser deux fois (mesuré sur vraie base). Un `prisma.$transaction` nu passerait
    // tous les autres tests de ce fichier.
    await POST(req({ kind: "pools" }), params);
    expect(h.txOptions).toMatchObject({ isolationLevel: "Serializable" });
  });

  it("fige le statut et la formule choisie", async () => {
    await POST(req({ kind: "pools_bracket", poolSizes: [4, 4] }), params);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "running", format: "pools_bracket" },
    });
  });

  it("trie les joueurs par seed avant de matérialiser", async () => {
    // L'ordre reçu de la base n'est pas garanti ; les têtes de série en dépendent.
    h.tournament = brouillon(8, {
      players: [
        { id: "c", seed: 2 },
        { id: "a", seed: 0 },
        { id: "z", seed: null },
        { id: "b", seed: 1 },
        ...Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, seed: i + 3 })),
      ],
    });
    await POST(req({ kind: "pools", poolSizes: [4, 4] }), params);
    const joueurs = h.materialize.mock.calls[0][3] as { id: string; seed: number }[];
    // `z` n'a pas de seed : traité comme 0, il passe devant.
    expect(joueurs.map((p) => p.id).slice(0, 4)).toEqual(["a", "z", "b", "c"]);
    expect(joueurs.map((p) => p.seed).slice(0, 4)).toEqual([0, 0, 1, 2]);
  });
});

describe("POST /api/tournaments/[id]/generate — la répartition en poules", () => {
  it.each([
    ["deux poules de 4", [4, 4]],
    ["trois poules à ±1", [3, 3, 2]],
  ])("accepte %s pour 8 joueurs", async (_cas, poolSizes) => {
    const res = await POST(req({ kind: "pools", poolSizes }), params);
    expect(res.status).toBe(200);
    expect(tailles()).toEqual(poolSizes);
  });

  it.each([
    ["le total est trop bas", [4, 3]],
    ["le total est trop haut", [5, 5]],
    ["une poule est vidée de deux joueurs", [6, 2]],
    ["l'écart dépasse un joueur", [5, 3]],
    // Un tableau VIDE est un tableau : il passe le contrôle de forme, puis échoue sur le
    // total (0 ≠ 8). C'est la frontière exacte entre « rien fourni » (repli) et « fourni,
    // mais faux » (refus) — `poolSizes: []` tombe du côté du refus.
    ["la liste est vide", []],
  ])("400 quand %s", async (_cas, poolSizes) => {
    // Refuser plutôt qu'accepter puis ignorer : `materialize` aurait fabriqué deux poules de 4
    // en silence, et le créateur aurait cru avoir choisi autre chose.
    const res = await POST(req({ kind: "pools", poolSizes }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Répartition en poules invalide" });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    ["absentes", undefined],
    ["pas un tableau", "4,4"],
    ["contenant une poule d'un seul joueur", [7, 1]],
    ["contenant un non-entier", [4.5, 3.5]],
  ])("retombe sur la proposition du moteur quand elles sont %s", async (_cas, poolSizes) => {
    // Un client qui n'envoie rien — ou n'importe quoi — obtient la formule que l'écran lui
    // aurait présélectionnée, pas un refus.
    const res = await POST(req({ kind: "pools", poolSizes }), params);
    expect(res.status).toBe(200);
    const attendu = proposeFormats(8, 3, { courts: 2 }).find((p) => p.kind === "pools")?.poolSizes;
    expect(tailles()).toEqual(attendu);
    // Et le repli reste une répartition VALIDE : la garde ne se contourne pas par omission.
    expect(tailles().reduce((s, x) => s + x, 0)).toBe(8);
    expect(Math.max(...tailles()) - Math.min(...tailles())).toBeLessThanOrEqual(1);
  });

  it.each([
    [2, [3, 3, 3, 3]],
    [3, [4, 4, 4]],
  ])("consulte le moteur avec la cible DU TOURNOI : %i matchs → %j", async (cible, attendu) => {
    // Codée en dur, la cible donnerait la même formule à tout le monde. À douze joueurs elle
    // décide seule entre quatre poules de 3 (2 matchs chacun) et trois poules de 4 (3 matchs) —
    // c'est-à-dire entre deux soirées différentes.
    //
    // (Le nombre de terrains, lui, ne peut PAS changer ce choix : il n'entre que dans la durée
    // estimée, qui sert de départage, et `ceil(t/c)` conserve l'ordre des totaux. On ne teste
    // donc pas une influence qui n'existe pas.)
    h.tournament = brouillon(12, { targetMatches: cible });
    const res = await POST(req({ kind: "pools" }), params);
    expect(res.status).toBe(200);
    expect(tailles()).toEqual(attendu);
  });

  it("si le moteur ne propose AUCUNE poule, tout le monde dans la même", async () => {
    // Dernier recours : une poule unique est jouable (round-robin intégral), là où `[]`
    // produirait un tournoi sans aucun match.
    h.propositions = [];
    const res = await POST(req({ kind: "pools" }), params);
    expect(res.status).toBe(200);
    expect(tailles()).toEqual([8]);
  });

  it("« poules + tableau final » subit la MÊME garde que « poules »", async () => {
    // La formule mixte matérialise d'abord exactement les mêmes poules : l'oublier laisserait
    // passer par une porte ce qu'on refuse par l'autre.
    const res = await POST(req({ kind: "pools_bracket", poolSizes: [6, 2] }), params);
    expect(res.status).toBe(400);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("un tableau seul ne reçoit aucune poule, même si le client en envoie", async () => {
    const res = await POST(req({ kind: "bracket", poolSizes: [6, 2] }), params);
    expect(res.status).toBe(200);
    expect(tailles()).toEqual([]);
  });
});
