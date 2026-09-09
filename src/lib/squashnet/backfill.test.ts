import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RankingRow } from "./client";

// On mocke le réseau (client), les sujets (refresh) et l'écriture (history) ; le RAPPROCHEMENT
// (match.ts) reste le vrai code — c'est lui qui décide si un mois est concluant, et le tester
// à travers le remplissage est le seul moyen de vérifier qu'on n'écrit pas n'importe quoi.
const h = vi.hoisted(() => ({
  getMonths: vi.fn(),
  searchRanking: vi.fn(),
  subjectsToRefresh: vi.fn(),
  knownCouples: vi.fn(),
  writePoint: vi.fn(),
  writeProbe: vi.fn(),
}));

vi.mock("./client", () => ({ getMonths: h.getMonths, searchRanking: h.searchRanking }));
vi.mock("./refresh", () => ({ subjectsToRefresh: h.subjectsToRefresh }));
vi.mock("./history", async (orig) => ({
  // `pointKey` reste le VRAI : c'est la clé partagée entre ce qu'on lit et ce qu'on saute, et
  // la mocker rendrait le test aveugle au seul endroit où les deux peuvent diverger.
  ...(await orig<typeof import("./history")>()),
  knownCouples: h.knownCouples,
  writePoint: h.writePoint,
  writeProbe: h.writeProbe,
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
function sujet(id: string, nom: string, licence?: string) {
  const tokens = nom.split(/\s+/);
  return {
    kind: "member" as const,
    id,
    name: nom,
    query: tokens[tokens.length - 1],
    identity: { givenName: "", familyName: nom },
    licence: licence ?? null,
  };
}

beforeEach(() => {
  h.getMonths.mockReset().mockResolvedValue(["2026-03-02", "2026-02-02", "2026-01-05"]);
  h.searchRanking.mockReset().mockResolvedValue([]);
  h.subjectsToRefresh.mockReset().mockResolvedValue([sujet("u1", "Jean Dupont")]);
  h.knownCouples.mockReset().mockResolvedValue(new Set<string>());
  h.writeProbe.mockReset().mockResolvedValue(undefined);
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
    h.knownCouples.mockResolvedValue(
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
  it("n'écrit RIEN sur un mois non concluant (introuvable, homonymes)", async () => {
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
    expect(h.knownCouples).not.toHaveBeenCalled();
  });

  // LE BUDGET — ce qui rend le bouton d'admin possible sans qu'une fonction Vercel soit tuée
  // en vol, donc sans compte-rendu.
  describe("budget de temps", () => {
    it("s'arrête proprement au budget et dit ce qu'il reste", async () => {
      h.subjectsToRefresh.mockResolvedValue([sujet("u1", "Jean Dupont"), sujet("u2", "Paul Martin")]);
      h.searchRanking.mockImplementation(async () => {
        // Chaque appel « coûte » du temps réel : le budget se mesure sur l'horloge.
        await new Promise((r) => setTimeout(r, 12));
        return [row("DUPONT JEAN"), row("MARTIN PAUL")];
      });
      const res = await backfillHistory({ delayMs: 0, budgetMs: 15 });
      expect(res.stopped).toBe(true);
      // 3 mois × 2 joueurs = 6 couples ; on s'arrête bien avant la fin.
      expect(res.written).toBeLessThan(6);
      expect(res.remaining).toBe(6 - res.written - res.unresolved - res.already - res.failed);
      expect(res.remaining).toBeGreaterThan(0);
    });

    it("un run qui va au bout ne laisse RIEN à faire, et ne se dit pas arrêté", async () => {
      h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
      const res = await run();
      expect(res).toMatchObject({ stopped: false, remaining: 0, written: 3 });
    });

    // « Sans réponse » n'est pas du travail restant : un joueur non licencié à l'époque n'aura
    // jamais de mesure ces mois-là. Les compter promettrait un « terminé » qui n'arriverait pas.
    it("les couples sans réponse ne comptent pas comme restants", async () => {
      h.searchRanking.mockResolvedValue([row("MARTIN PIERRE")]);
      const res = await run();
      expect(res).toMatchObject({ unresolved: 3, remaining: 0, stopped: false });
    });

    it("le budget se vérifie AVANT d'engager un couple, jamais après avoir payé la requête", async () => {
      // Budget déjà épuisé à l'entrée : aucune requête ne part, et tout reste à faire.
      const res = await backfillHistory({ delayMs: 0, budgetMs: 0 });
      expect(res).toMatchObject({ requests: 0, written: 0, stopped: true, remaining: 3 });
      expect(h.searchRanking).not.toHaveBeenCalled();
    });

    // Sur un historique déjà complet, recliquer ne doit RIEN coûter à squashnet.
    it("un second passage sur un historique complet ne fait aucune requête et ne dit rien de restant", async () => {
      h.knownCouples.mockResolvedValue(
        new Set(["member:u1:2026-03-02", "member:u1:2026-02-02", "member:u1:2026-01-05"]),
      );
      const res = await backfillHistory({ delayMs: 0, budgetMs: 45_000 });
      expect(res).toMatchObject({ requests: 0, already: 3, remaining: 0, stopped: false });
    });
  });

  it("rend l'avancement mois par mois, pour qu'un long run se suive", async () => {
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    const vus: string[] = [];
    await run({ onMonth: (m: string) => vus.push(m) });
    expect(vus).toEqual(["2026-03-02", "2026-02-02", "2026-01-05"]);
  });
});

describe("backfillHistory — l'historique suit le JOUEUR, pas le membre du club", () => {
  it("capte un mois où le joueur était licencié AILLEURS", async () => {
    // LE CAS QUI MOTIVE TOUT CE MODE. Un membre arrivé au club l'an dernier a une progression
    // avant son arrivée ; la refuser parce que le libellé du club diffère confondrait « il est
    // parti » avec « il n'était pas encore là ». Le rafraîchissement mensuel, lui, garde le
    // filtre par club — c'est de là qu'il tire son verdict `moved`.
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN", { club: "Squash Club de Massy" })]);
    const res = await run();
    expect(res).toMatchObject({ written: 3, unresolved: 0 });
  });

  it("la LICENCE tranche entre deux homonymes, là où le nom seul renonce", async () => {
    h.subjectsToRefresh.mockResolvedValue([sujet("u1", "Jean Dupont", "0000042")]);
    h.searchRanking.mockResolvedValue([
      row("DUPONT JEAN", { club: "Squash Club de Massy", licence: "0000042", rangM: "1800" }),
      row("DUPONT JEAN", { club: "Squash de Palaiseau", licence: "0000099", rangM: "2500" }),
    ]);
    const res = await run();
    expect(res).toMatchObject({ written: 3, unresolved: 0 });
    expect(h.writePoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ licence: "0000042", rangM: 1800 }),
      expect.any(String),
    );
  });

  it("sans licence, deux homonymes restent AMBIGUS plutôt que tirés au sort", async () => {
    h.searchRanking.mockResolvedValue([
      row("DUPONT JEAN", { club: "Squash Club de Massy", licence: "0000042" }),
      row("DUPONT JEAN", { club: "Squash de Palaiseau", licence: "0000099" }),
    ]);
    const res = await run();
    expect(res).toMatchObject({ written: 0, unresolved: 3 });
  });
});

describe("backfillHistory — la mémoire des trous", () => {
  it("MARQUE un couple cherché en vain alors que squashnet a répondu", async () => {
    h.searchRanking.mockResolvedValue([row("MARTIN PIERRE")]); // quelqu'un d'autre
    await run();
    expect(h.writeProbe).toHaveBeenCalledTimes(3);
    expect(h.writeProbe).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "2026-03-02",
      "unknown",
    );
  });

  it("ne marque RIEN quand squashnet n'a pas répondu : c'est un incident, pas un verdict", async () => {
    h.searchRanking.mockRejectedValue(new Error("timeout"));
    const res = await run();
    expect(res).toMatchObject({ written: 0 });
    expect(h.writeProbe).not.toHaveBeenCalled();
  });

  it("saute les couples DÉJÀ MARQUÉS — c'est ce qui fait converger « reste »", async () => {
    h.knownCouples.mockResolvedValue(
      new Set(["member:u1:2026-03-02", "member:u1:2026-02-02", "member:u1:2026-01-05"]),
    );
    const res = await run();
    expect(res).toMatchObject({ already: 3, written: 0, remaining: 0 });
    expect(h.searchRanking).not.toHaveBeenCalled();
  });

  it("`retryProbes` demande la reprise des marques, pour un nom corrigé", async () => {
    await run({ retryProbes: true });
    expect(h.knownCouples).toHaveBeenCalledWith(expect.any(Array), { retryProbes: true });
  });

  it("un échec d'écriture de la MARQUE ne fait pas perdre le lot", async () => {
    // La marque est un confort, pas une donnée : au pire le couple sera redemandé au passage
    // suivant, ce qui est exactement l'ancien comportement.
    h.searchRanking.mockResolvedValue([row("MARTIN PIERRE")]);
    h.writeProbe.mockRejectedValue(new Error("base injoignable"));
    const res = await run();
    expect(res).toMatchObject({ unresolved: 3, failed: 0 });
  });
});
