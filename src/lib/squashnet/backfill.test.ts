import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RankingRow } from "./client";

// On mocke le réseau (client), les sujets (refresh) et l'écriture (history) ; le RAPPROCHEMENT
// (match.ts) reste le vrai code — c'est lui qui décide si un mois est concluant, et le tester
// à travers le remplissage est le seul moyen de vérifier qu'on n'écrit pas n'importe quoi.
const h = vi.hoisted(() => ({
  getMonths: vi.fn(),
  searchRanking: vi.fn(),
  subjectsToRefresh: vi.fn(),
  knownPoints: vi.fn(),
  writePoint: vi.fn(),
}));

vi.mock("./client", () => ({ getMonths: h.getMonths, searchRanking: h.searchRanking }));
vi.mock("./refresh", () => ({ subjectsToRefresh: h.subjectsToRefresh }));
vi.mock("./history", async (orig) => ({
  // `pointKey` reste le VRAI : c'est la clé partagée entre ce qu'on lit et ce qu'on saute, et
  // la mocker rendrait le test aveugle au seul endroit où les deux peuvent diverger.
  ...(await orig<typeof import("./history")>()),
  knownPoints: h.knownPoints,
  writePoint: h.writePoint,
}));

import { backfillHistory } from "./backfill";

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

/** Un sujet au format de `subjectsToRefresh` (nom de famille en terme de recherche). */
function sujet(id: string, nom: string) {
  const tokens = nom.split(/\s+/);
  return {
    kind: "member" as const,
    id,
    name: nom,
    query: tokens[tokens.length - 1],
    identity: { givenName: "", familyName: nom },
  };
}

beforeEach(() => {
  h.getMonths.mockReset().mockResolvedValue(["2026-03-02", "2026-02-02", "2026-01-05"]);
  h.searchRanking.mockReset().mockResolvedValue([]);
  h.subjectsToRefresh.mockReset().mockResolvedValue([sujet("u1", "Jean Dupont")]);
  h.knownPoints.mockReset().mockResolvedValue(new Set<string>());
  h.writePoint.mockReset().mockResolvedValue(undefined);
});

const run = (opts = {}) => backfillHistory({ delayMs: 0, ...opts });

describe("backfillHistory", () => {
  it("écrit un point par mois concluant, avec le mois demandé", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    const res = await run();
    expect(res).toMatchObject({ months: expect.any(Array), written: 3, unresolved: 0, failed: 0 });
    expect(h.searchRanking).toHaveBeenCalledWith("Dupont", { month: "2026-03-02" });
    expect(h.writePoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      expect.objectContaining({ clt: "5A" }),
      "2026-01-05",
    );
  });

  it("ne remonte que le nombre de périodes demandé", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    const res = await run({ months: 2 });
    expect(res.months).toEqual(["2026-03-02", "2026-02-02"]);
    expect(res.written).toBe(2);
  });

  // C'est ce qui rend le remplissage REPRENABLE : interrompu au bout de dix minutes, relancé le
  // lendemain, il ne redemande pas à la fédération ce qu'il tient déjà. Un second passage sur un
  // club à jour ne fait AUCUNE requête.
  it("saute les couples (joueur, mois) déjà en base, sans appeler squashnet", async () => {
    h.knownPoints.mockResolvedValue(
      new Set(["member:u1:2026-03-02", "member:u1:2026-02-02", "member:u1:2026-01-05"]),
    );
    const res = await run();
    expect(res).toMatchObject({ already: 3, written: 0, requests: 0 });
    expect(h.searchRanking).not.toHaveBeenCalled();
  });

  // Deux joueurs du même nom de famille (il y en a) partagent la réponse : une recherche, deux
  // rapprochements.
  it("mutualise UNE recherche entre les homonymes du même mois", async () => {
    h.subjectsToRefresh.mockResolvedValue([sujet("u1", "Jean Dupont"), sujet("u2", "Paul Dupont")]);
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN"), row("DUPONT PAUL")]);
    const res = await run({ months: 1 });
    expect(h.searchRanking).toHaveBeenCalledOnce();
    expect(res.written).toBe(2);
  });

  it("ne partage PAS le mémo d'un mois à l'autre : ce serait donner à février le classement de janvier", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    await run();
    expect(h.searchRanking).toHaveBeenCalledTimes(3);
    expect(h.searchRanking.mock.calls.map((c) => c[1].month)).toEqual([
      "2026-03-02",
      "2026-02-02",
      "2026-01-05",
    ]);
  });

  // « On n'écrit que ce qu'on a vu » : un trou dit « on ne sait pas », une valeur reportée
  // affirmerait une stabilité qu'on n'a pas mesurée.
  it("n'écrit RIEN sur un mois non concluant (introuvable, homonymes, autre club)", async () => {
    h.searchRanking.mockResolvedValue([row("MARTIN PIERRE")]); // personne au nom du sujet
    const res = await run();
    expect(res).toMatchObject({ written: 0, unresolved: 3 });
    expect(h.writePoint).not.toHaveBeenCalled();
  });

  it("une panne squashnet laisse le mois OUVERT (ni écrit, ni marqué), sans interrompre le lot", async () => {
    h.searchRanking
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue([row("DUPONT JEAN")]);
    const res = await run();
    expect(res).toMatchObject({ unresolved: 1, written: 2 });
  });

  it("une panne base est comptée `failed`, jamais imputée à squashnet", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    h.writePoint.mockRejectedValueOnce(new Error("base injoignable"));
    const res = await run();
    expect(res).toMatchObject({ failed: 1, written: 2, unresolved: 0 });
  });

  it("mémoïse aussi l'ÉCHEC : trois homonymes ne rejouent pas trois fois la requête qui vient d'échouer", async () => {
    h.subjectsToRefresh.mockResolvedValue([sujet("u1", "Jean Dupont"), sujet("u2", "Paul Dupont")]);
    h.searchRanking.mockRejectedValue(new Error("timeout"));
    const res = await run({ months: 1 });
    expect(h.searchRanking).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ unresolved: 2, requests: 1 });
  });

  it("aucune période publiée → aucune requête, aucun compteur inventé", async () => {
    h.getMonths.mockResolvedValue([]);
    const res = await run();
    expect(res).toMatchObject({ months: [], written: 0, requests: 0 });
    expect(h.knownPoints).not.toHaveBeenCalled();
  });

  it("rend l'avancement mois par mois, pour qu'un long run se suive", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    const vus: string[] = [];
    await run({ onMonth: (m: string) => vus.push(m) });
    expect(vus).toEqual(["2026-03-02", "2026-02-02", "2026-01-05"]);
  });
});
