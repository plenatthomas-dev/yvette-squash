import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RankingRow } from "./client";

// On mocke la couche réseau (client) et la base (prisma) ; le RAPPROCHEMENT (match.ts) reste
// le vrai code, pour tester le comportement de bout en bout de refreshRankings().
const h = vi.hoisted(() => ({
  members: [] as { id: string; displayName: string }[],
  getLatestMonth: vi.fn(),
  searchRanking: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("./client", () => ({
  getLatestMonth: h.getLatestMonth,
  searchRanking: h.searchRanking,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: h.findMany },
    squashnetRanking: { upsert: h.upsert, deleteMany: h.deleteMany },
  },
}));

import { refreshRankings, summarizeRefresh } from "./refresh";
import type { RefreshResult } from "./refresh";

// Fabrique une ligne squashnet ; club Yvette par défaut (celui que matchRanking cible).
function row(name: string, over: Partial<RankingRow> = {}): RankingRow {
  return {
    name,
    clt: "5A",
    club: "Squash de l yvette",
    licence: "0000001",
    ligue: "IDF",
    cat: "Senior",
    gender: "male",
    rang: "42",
    rangM: "30",
    mean: "1 000",
    ...over,
  };
}

beforeEach(() => {
  h.getLatestMonth.mockReset().mockResolvedValue("2026-07-07");
  h.searchRanking.mockReset();
  h.upsert.mockReset().mockResolvedValue({});
  h.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  h.findMany.mockReset().mockImplementation(async () => h.members);
});

describe("refreshRankings", () => {
  it("période introuvable → n'interroge ni la base ni squashnet", async () => {
    h.getLatestMonth.mockResolvedValueOnce(null);
    const res = await refreshRankings();
    expect(res).toEqual({ month: null, members: 0, matched: 0, cleared: 0, skipped: 0, failed: 0, bulkMoveBlocked: false });
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.searchRanking).not.toHaveBeenCalled();
  });

  it("hit unique dans le club → upsert du classement (matched)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN")]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 1, cleared: 0, skipped: 0 });
    expect(h.upsert).toHaveBeenCalledOnce();
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("membre retrouvé UNIQUEMENT dans un autre club → suppression (moved)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Son nom colle, mais la seule ligne est ailleurs → il a quitté l'Yvette : signal fiable.
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 1, skipped: 0 });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("aucune ligne au nom du membre (autres joueurs) → NE supprime PAS (page 2 possible)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Homonymes de nom de FAMILLE seulement (prénoms différents) : le membre peut être en page 2.
    h.searchRanking.mockResolvedValueOnce([
      row("DUPONT PIERRE", { club: "Autre Club" }),
      row("DUPONT MARC", { club: "Encore Autre" }),
    ]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("homonymes AMBIGUS dans le club → NE supprime NI n'écrit rien (skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Deux « Jean Dupont » plausibles dans le club → on n'affirme pas et on ne supprime pas.
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN"), row("DUPONT JEAN PIERRE")]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("réponse VIDE → NE supprime PAS (non concluant, skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockResolvedValueOnce([]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("erreur squashnet → n'écrase rien (skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockRejectedValueOnce(new Error("timeout"));
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("panne base à l'écriture → comptée `failed` (pas `skipped`), sans avorter le lot", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" },
      { id: "u2", displayName: "Marie Martin" },
    ];
    h.searchRanking
      .mockResolvedValueOnce([row("DUPONT JEAN")])
      .mockResolvedValueOnce([row("MARTIN MARIE", { gender: "female" })]);
    h.upsert.mockRejectedValueOnce(new Error("Neon down")).mockResolvedValueOnce({});
    const res = await refreshRankings();
    // u1 échoue (failed), mais u2 est bien traité derrière → le lot n'est pas interrompu.
    expect(res).toMatchObject({ matched: 1, failed: 1, skipped: 0, cleared: 0 });
  });

  it("exclut les displayName vides du compteur `members` (non évaluables)", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" },
      { id: "u2", displayName: "   " }, // nom vide → ignoré, ne compte pas
    ];
    h.searchRanking.mockResolvedValueOnce([]); // squashnet muet pour l'unique membre évaluable
    const res = await refreshRankings();
    // members reflète les membres RÉELLEMENT évaluables → tous ignorés (base d'un heartbeat honnête).
    expect(res).toMatchObject({ members: 1, skipped: 1, matched: 0 });
    expect(h.searchRanking).toHaveBeenCalledOnce();
  });

  it("disjoncteur : un LOT de `moved` (club renommé côté squashnet) → aucune suppression", async () => {
    // 6 membres, tous « retrouvés ailleurs » d'un coup → anomalie systémique probable.
    h.members = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, displayName: "Jean Dupont" }));
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res.bulkMoveBlocked).toBe(true);
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 6 });
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("départ individuel (sous le seuil) → suppression normale, pas de blocage", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" }, // parti ailleurs → moved
      { id: "u2", displayName: "Marie Martin" }, // toujours au club → matched
    ];
    h.searchRanking
      .mockResolvedValueOnce([row("DUPONT JEAN", { club: "Squash Club de Rennes" })])
      .mockResolvedValueOnce([row("MARTIN MARIE", { gender: "female" })]);
    const res = await refreshRankings();
    expect(res.bulkMoveBlocked).toBe(false);
    expect(res).toMatchObject({ matched: 1, cleared: 1, skipped: 0 });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});

describe("summarizeRefresh", () => {
  const base: RefreshResult = {
    month: "2026-07-07",
    members: 5,
    matched: 3,
    cleared: 1,
    skipped: 1,
    failed: 0,
    bulkMoveBlocked: false,
  };

  it("ok quand rien d'anormal (même sans changement)", () => {
    expect(summarizeRefresh(base).ok).toBe(true);
    expect(summarizeRefresh({ ...base, matched: 0, cleared: 0, skipped: 0 }).ok).toBe(true);
  });

  it("ok=false si une écriture base a échoué", () => {
    expect(summarizeRefresh({ ...base, failed: 1 }).ok).toBe(false);
  });

  it("ok=false si le disjoncteur a bloqué des suppressions", () => {
    expect(summarizeRefresh({ ...base, bulkMoveBlocked: true }).ok).toBe(false);
  });

  it("ok=false si TOUS les membres ont été ignorés (squashnet muet)", () => {
    expect(summarizeRefresh({ ...base, matched: 0, cleared: 0, skipped: 5 }).ok).toBe(false);
  });

  it("info mentionne échecs et blocage quand présents", () => {
    const { info } = summarizeRefresh({ ...base, failed: 2, bulkMoveBlocked: true });
    expect(info).toContain("2 échec(s) base");
    expect(info).toContain("BLOQUÉE");
  });
});
