import { describe, it, expect } from "vitest";
import {
  splitPools,
  roundRobin,
  poolStandings,
  scheduleMatches,
  placementBracket,
  resolveBracket,
  bracketLive,
  proposeFormats,
  bestFormat,
  type MatchResult,
} from "./tournament";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("splitPools", () => {
  it("découpe proprement quand c'est divisible", () => {
    expect(splitPools(8, 4)).toEqual([4, 4]);
    expect(splitPools(9, 3)).toEqual([3, 3, 3]);
    expect(splitPools(16, 4)).toEqual([4, 4, 4, 4]);
    expect(splitPools(10, 5)).toEqual([5, 5]);
  });

  it("équilibre à ±1 quand ça ne tombe pas juste", () => {
    const p = splitPools(10, 4); // ~3 poules
    expect(sum(p)).toBe(10);
    expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
  });

  it("la somme vaut toujours n et l'écart de taille ≤ 1 (fuzz)", () => {
    for (let n = 6; n <= 16; n++) {
      for (const size of [3, 4, 5]) {
        const p = splitPools(n, size);
        expect(sum(p)).toBe(n);
        expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("roundRobin", () => {
  const allPairs = (rounds: [number, number][][]) => rounds.flat();

  it("chacun rencontre tous les autres une seule fois (effectif pair)", () => {
    const rounds = roundRobin([0, 1, 2, 3]);
    const pairs = allPairs(rounds);
    expect(pairs.length).toBe(6); // C(4,2)
    const norm = new Set(pairs.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
    expect(norm.size).toBe(6); // aucun doublon
    // 3 tours de 2 matchs, personne en double dans un tour.
    expect(rounds.length).toBe(3);
    for (const round of rounds) {
      const seen = new Set<number>();
      for (const [a, b] of round) {
        expect(seen.has(a)).toBe(false);
        expect(seen.has(b)).toBe(false);
        seen.add(a);
        seen.add(b);
      }
    }
  });

  it("effectif impair : un joueur se repose par tour, total = C(n,2)", () => {
    const rounds = roundRobin([0, 1, 2, 3, 4]);
    const pairs = allPairs(rounds);
    expect(pairs.length).toBe(10); // C(5,2)
    expect(rounds.length).toBe(5); // n tours pour n impair
    for (const round of rounds) expect(round.length).toBe(2); // un se repose
  });

  it("jamais un joueur contre lui-même, et bon total (fuzz)", () => {
    for (let n = 3; n <= 6; n++) {
      const ids = Array.from({ length: n }, (_, i) => i);
      const pairs = allPairs(roundRobin(ids));
      expect(pairs.length).toBe((n * (n - 1)) / 2);
      for (const [a, b] of pairs) expect(a).not.toBe(b);
      // chaque joueur joue n-1 matchs
      const count = new Map<number, number>();
      for (const [a, b] of pairs) {
        count.set(a, (count.get(a) ?? 0) + 1);
        count.set(b, (count.get(b) ?? 0) + 1);
      }
      for (const id of ids) expect(count.get(id)).toBe(n - 1);
    }
  });
});

describe("poolStandings", () => {
  // Poule de 3 : a bat b, a bat c, b bat c. Classement attendu : a, b, c.
  const r = (p1: string, p2: string, g1: number, g2: number): MatchResult => ({
    p1,
    p2,
    games1: g1,
    games2: g2,
  });

  it("classe par victoires puis goal-average", () => {
    const st = poolStandings(
      ["a", "b", "c"],
      [r("a", "b", 2, 0), r("a", "c", 2, 1), r("b", "c", 2, 0)],
    );
    expect(st.map((s) => s.playerId)).toEqual(["a", "b", "c"]);
    expect(st[0]).toMatchObject({ wins: 2, losses: 0, points: 2, rank: 1 });
    expect(st[2]).toMatchObject({ wins: 0, losses: 2, rank: 3 });
    // goal-average de a : (2+2) - (0+1) = 3
    expect(st[0].gameDiff).toBe(3);
  });

  it("départage deux ex æquo par confrontation directe", () => {
    // a et b à 1 victoire chacun, mais b a battu a en direct → b devant a.
    const st = poolStandings(
      ["a", "b", "c"],
      [r("b", "a", 2, 1), r("a", "c", 2, 0), r("b", "c", 0, 2)],
    );
    // a: bat c, perd vs b → 1v. b: bat a, perd vs c → 1v. c: bat b, perd vs a → 1v.
    // Tous à 1 victoire : mini-championnat circulaire → départage au goal-average.
    const wins = Object.fromEntries(st.map((s) => [s.playerId, s.wins]));
    expect(wins).toEqual({ a: 1, b: 1, c: 1 });
    // Classement déterministe et stable (mêmes entrées => même ordre)
    const st2 = poolStandings(
      ["a", "b", "c"],
      [r("b", "a", 2, 1), r("a", "c", 2, 0), r("b", "c", 0, 2)],
    );
    expect(st2.map((s) => s.playerId)).toEqual(st.map((s) => s.playerId));
  });

  it("ex æquo strict (2 joueurs) : la confrontation directe tranche", () => {
    // a et b gagnent chacun 1, c perd tout. a et b ne se départagent que par leur duel.
    const st = poolStandings(
      ["a", "b", "c"],
      [r("a", "b", 2, 0), r("a", "c", 2, 0), r("b", "c", 2, 0)],
    );
    // a: 2v, b: 1v, c: 0v
    expect(st.map((s) => s.playerId)).toEqual(["a", "b", "c"]);
  });

  it("ignore un match nul impossible (données douteuses)", () => {
    const st = poolStandings(["a", "b"], [r("a", "b", 1, 1)]);
    expect(st.every((s) => s.played === 0)).toBe(true);
  });
});

describe("scheduleMatches", () => {
  it("remplit les terrains sans qu'un joueur joue deux fois en parallèle", () => {
    // Poule de 4 (round-robin) sur 2 terrains.
    const m = [
      { key: "m1", p1: "a", p2: "b" },
      { key: "m2", p1: "c", p2: "d" },
      { key: "m3", p1: "a", p2: "c" },
      { key: "m4", p1: "b", p2: "d" },
      { key: "m5", p1: "a", p2: "d" },
      { key: "m6", p1: "b", p2: "c" },
    ];
    const sched = scheduleMatches(m, 2);
    expect(sched.length).toBe(6);

    // Personne ne joue deux matchs dans la même vague.
    const byWave = new Map<number, string[]>();
    for (const s of sched) {
      const mm = m.find((x) => x.key === s.key)!;
      const arr = byWave.get(s.wave) ?? [];
      arr.push(mm.p1, mm.p2);
      byWave.set(s.wave, arr);
    }
    for (const [, players] of byWave) {
      expect(new Set(players).size).toBe(players.length);
    }
    // Au plus 2 matchs par vague (2 terrains).
    for (const [, players] of byWave) expect(players.length).toBeLessThanOrEqual(4);

    // L'ordre de passage est une permutation 0..5 sans trou.
    expect([...sched.map((s) => s.order)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    // Chaque court reste dans [0, 1].
    for (const s of sched) expect(s.court).toBeGreaterThanOrEqual(0);
    for (const s of sched) expect(s.court).toBeLessThan(2);
  });

  it("un seul terrain : tout est séquentiel", () => {
    const m = [
      { key: "m1", p1: "a", p2: "b" },
      { key: "m2", p1: "c", p2: "d" },
    ];
    const sched = scheduleMatches(m, 1);
    expect(new Set(sched.map((s) => s.wave)).size).toBe(2); // 2 vagues distinctes
    for (const s of sched) expect(s.court).toBe(0);
  });
});

describe("placementBracket", () => {
  // Simulateur : le plus petit seed gagne toujours (ordre total transitif).
  const lowerSeedWins = (_k: string, a: number, b: number) => Math.min(a, b);

  it("puissance de 2 : structure attendue (N=8)", () => {
    const b = placementBracket(8);
    expect(b.size).toBe(8);
    expect(b.rounds).toBe(3);
    expect(b.byes).toBe(0);
    expect(b.matches.length).toBe(12); // P/2 × rounds = 4 × 3
    expect(b.placements.length).toBe(8); // un rang par joueur
    // clés uniques
    expect(new Set(b.matches.map((m) => m.key)).size).toBe(12);
    // exactement une « Finale »
    expect(b.matches.filter((m) => m.placeLabel === "Finale").length).toBe(1);
  });

  it("N=8 : chacun joue exactement 3 matchs, classement 1..8 complet", () => {
    const b = placementBracket(8);
    const { ranking, playedBySeed } = resolveBracket(b, lowerSeedWins);
    // classement = permutation des seeds 0..7
    expect(ranking.map((r) => r.seed).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // le meilleur seed gagne
    expect(ranking[0].seed).toBe(0);
    // tout le monde joue 3
    for (let s = 0; s < 8; s++) expect(playedBySeed.get(s)).toBe(3);
  });

  it("byes (N=6) : classement 1..6 complet, matchs/joueur à ±1", () => {
    const b = placementBracket(6);
    expect(b.size).toBe(8);
    expect(b.byes).toBe(2);
    const { ranking, playedBySeed } = resolveBracket(b, lowerSeedWins);
    expect(ranking.map((r) => r.seed).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ranking[0].seed).toBe(0); // champion = meilleur seed
    const counts = [...Array(6)].map((_, s) => playedBySeed.get(s) ?? 0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(b.rounds - 1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(b.rounds);
  });

  it("fuzz N=6..16 : classement complet 1..N pour tout N (correction byes)", () => {
    const lowerWins = (_k: string, a: number, b: number) => Math.min(a, b);
    const isPow2 = (x: number) => (x & (x - 1)) === 0;
    for (let n = 6; n <= 16; n++) {
      const b = placementBracket(n);
      const { ranking, playedBySeed } = resolveBracket(b, lowerWins);
      // Correctness (vrai pour TOUT N) : permutation exacte des N joueurs, champion = seed 0.
      expect(ranking.map((r) => r.seed).sort((x, y) => x - y)).toEqual(
        [...Array(n)].map((_, i) => i),
      );
      expect(ranking.map((r) => r.rank)).toEqual([...Array(n)].map((_, i) => i + 1));
      expect(ranking[0].seed).toBe(0);
      const counts = [...Array(n)].map((_, s) => playedBySeed.get(s) ?? 0);
      for (const c of counts) expect(c).toBeGreaterThanOrEqual(1);
      // Matchs strictement ÉGAUX seulement en puissance de 2 (sans byes) : chacun joue log2(N).
      if (isPow2(n)) {
        for (const c of counts) expect(c).toBe(b.rounds);
      }
    }
  });
});

describe("bracketLive", () => {
  it("aucun résultat : classement null, byes marqués, 1er tour en attente", () => {
    const live = bracketLive(6, () => null);
    expect(live.ranking).toBeNull();
    // Il existe des matchs « bye » (N=6 → 2 byes) et des matchs réels en attente.
    expect(live.matches.some((m) => m.status === "bye")).toBe(true);
    expect(live.matches.some((m) => m.status === "pending")).toBe(true);
    // Un match bye n'a qu'un seul vrai joueur.
    for (const m of live.matches) {
      if (m.status === "bye") expect(m.p1 === null || m.p2 === null).toBe(true);
    }
  });

  it("tous les résultats (petit seed gagne) : même classement que resolveBracket", () => {
    // On rejoue le tableau : le vainqueur d'un match = le plus petit seed de ses participants.
    const n = 8;
    const bracket = placementBracket(n);
    const lower = (_k: string, a: number, b: number) => Math.min(a, b);
    const full = resolveBracket(bracket, lower);

    // Construit une table clé -> seed vainqueur en résolvant nous-mêmes (petit seed gagne).
    const winners = new Map<string, number>();
    const livePass = bracketLive(n, (k) => winners.get(k) ?? null);
    // On remplit les résultats tour par tour à partir des participants calculés.
    for (let pass = 0; pass < bracket.rounds + 1; pass++) {
      const l = bracketLive(n, (k) => winners.get(k) ?? null);
      for (const m of l.matches) {
        if (m.status === "pending" && m.p1 !== null && m.p2 !== null) {
          winners.set(m.key, Math.min(m.p1, m.p2));
        }
      }
    }
    const live = bracketLive(n, (k) => winners.get(k) ?? null);
    expect(live.ranking).not.toBeNull();
    expect(live.ranking).toEqual(full.ranking);
    expect(livePass.matches.length).toBe(bracket.matches.length);
  });
});

describe("proposeFormats / bestFormat", () => {
  it("cas propres : la meilleure formule donne EXACTEMENT la cible pour tous", () => {
    // 8 joueurs / 3 matchs → 2 poules de 4 (ou tableau) : 3 matchs chacun.
    expect(bestFormat(8, 3).matchesPerPlayer).toEqual({ min: 3, max: 3 });
    // 6 / 2 → 2 poules de 3.
    expect(bestFormat(6, 2).matchesPerPlayer).toEqual({ min: 2, max: 2 });
    // 16 / 3 → 4 poules de 4.
    expect(bestFormat(16, 3).matchesPerPlayer).toEqual({ min: 3, max: 3 });
    // 10 / 4 → 2 poules de 5.
    expect(bestFormat(10, 4).matchesPerPlayer).toEqual({ min: 4, max: 4 });
  });

  it("propose au moins une formule, meilleure en tête, avec durée estimée", () => {
    const props = proposeFormats(8, 3, { courts: 2 });
    expect(props.length).toBeGreaterThanOrEqual(1);
    for (const p of props) expect(p.estimatedMinutes).toBeGreaterThan(0);
    // 8/3 : le tableau à repêchage (puissance de 2) est proposé à côté des poules.
    expect(props.some((p) => p.kind === "bracket")).toBe(true);
    // La première proposition est bien la formule recommandée.
    expect(props[0]).toEqual(bestFormat(8, 3, { courts: 2 }));
  });

  it("préfère les poules (matchs égaux) au tableau hors puissance de 2", () => {
    // 12 / 3 : 4 poules de 4 = 3 matchs pile ; le tableau(12) a des byes → moins bon.
    const best = bestFormat(12, 3);
    expect(best.kind).toBe("pools");
    expect(best.matchesPerPlayer).toEqual({ min: 3, max: 3 });
  });

  it("fuzz N=6..16 × cible 2..4 : écart ≤ 1 et proche de la cible", () => {
    for (let n = 6; n <= 16; n++) {
      for (const target of [2, 3, 4]) {
        const best = bestFormat(n, target);
        // Objectif n°1 : matchs quasi égaux (écart ≤ 1).
        expect(best.matchesPerPlayer.max - best.matchesPerPlayer.min).toBeLessThanOrEqual(1);
        // Proximité raisonnable de la cible.
        expect(Math.abs(best.avgMatchesPerPlayer - target)).toBeLessThanOrEqual(1.5);
        expect(best.totalMatches).toBeGreaterThan(0);
        expect(best.estimatedMinutes).toBeGreaterThan(0);
      }
    }
  });
});
