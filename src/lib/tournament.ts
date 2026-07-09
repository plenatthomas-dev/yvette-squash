// Logique PURE des tournois (aucune dépendance DB) : découpage en poules, calendrier
// round-robin, classements et planning des terrains. Testée au fuzz (cf. tournament.test.ts),
// comme la logique d'argent du tricount. Les joueurs sont manipulés par INDEX (0..n-1) ou
// par identifiant opaque (string) ; la couche API fait la correspondance avec la base.

export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 16;

/**
 * Découpe `n` joueurs en poules de taille la plus proche possible de `poolSize`,
 * équilibrées : le nombre de poules est arrondi à partir de n/poolSize, puis on répartit
 * les joueurs au plus juste (tailles `base` ou `base+1`). La somme des tailles vaut `n`,
 * et deux poules diffèrent d'au plus 1 joueur (donc d'au plus 1 match/joueur).
 */
export function splitPools(n: number, poolSize: number): number[] {
  if (n <= 0) return [];
  const g = Math.max(1, Math.round(n / poolSize));
  const base = Math.floor(n / g);
  const extra = n % g;
  // Les `extra` premières poules ont un joueur de plus (les plus grosses d'abord).
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Répartition des têtes de série en `g` poules par la méthode standard « pots + serpentin » :
 * les seeds 0..n-1 (0 = meilleur) sont découpés en pots de G ; Pot 1 réparti poule 0→G-1,
 * Pot 2 en sens INVERSE, Pot 3 dans l'ordre, etc. → poules équilibrées en force (chaque poule
 * a un joueur de chaque pot). Renvoie, pour chaque poule, la liste des index de seed.
 */
export function snakeGroups(n: number, g: number): number[][] {
  const buckets: number[][] = Array.from({ length: Math.max(1, g) }, () => []);
  for (let i = 0; i < n; i++) {
    const pot = Math.floor(i / g);
    const pos = i % g;
    buckets[pot % 2 === 0 ? pos : g - 1 - pos].push(i);
  }
  return buckets;
}

/**
 * Calendrier round-robin d'une poule par la MÉTHODE DU CERCLE : chaque joueur rencontre
 * tous les autres exactement une fois, et à l'intérieur d'un « tour » personne ne joue
 * deux fois (utile pour paralléliser sur plusieurs terrains). Si le nombre de joueurs est
 * impair, un joueur se repose à chaque tour (bye). Renvoie la liste des tours, chaque tour
 * étant une liste de paires [i, j] d'index de joueurs.
 */
export function roundRobin(players: number[]): [number, number][][] {
  const real = [...players];
  if (real.length < 2) return [];
  // Joueur fictif (-1) pour un effectif impair : ses paires sont retirées (= repos).
  const arr = real.length % 2 === 1 ? [...real, -1] : [...real];
  const k = arr.length;
  const rounds: [number, number][][] = [];
  // arr[0] reste fixe, les autres tournent d'un cran à chaque tour.
  const rotating = arr.slice();
  for (let r = 0; r < k - 1; r++) {
    const round: [number, number][] = [];
    for (let i = 0; i < k / 2; i++) {
      const a = rotating[i];
      const b = rotating[k - 1 - i];
      if (a !== -1 && b !== -1) round.push([a, b]);
    }
    rounds.push(round);
    // Rotation : on garde l'index 0, on décale le reste (le dernier repasse en tête).
    const fixed = rotating[0];
    const tail = rotating.slice(1);
    tail.unshift(tail.pop() as number);
    rotating.splice(0, rotating.length, fixed, ...tail);
  }
  return rounds;
}

// Résultat d'un match, en JEUX gagnés (le vainqueur = celui qui a le plus de jeux).
export interface MatchResult {
  p1: string;
  p2: string;
  games1: number;
  games2: number;
}

export interface StandingRow {
  playerId: string;
  played: number;
  wins: number;
  losses: number;
  gamesFor: number;
  gamesAgainst: number;
  gameDiff: number; // « goal-average » en jeux
  points: number; // 1 par victoire
  rank: number; // 1 = tête de poule
}

/**
 * Classement d'une poule à partir des résultats connus. Départage DÉTERMINISTE :
 *  1) points (= victoires) ;
 *  2) mini-championnat entre ex æquo (victoires dans les matchs qui les opposent) ;
 *  3) goal-average jeux (jeux pour − jeux contre) ;
 *  4) jeux marqués ;
 *  5) ordre d'entrée (seed) — stable.
 * `playerIds` fixe l'ordre de départage final (seed). Seuls les matchs des deux joueurs
 * de la poule sont pris en compte.
 */
export function poolStandings(playerIds: string[], results: MatchResult[]): StandingRow[] {
  const inPool = new Set(playerIds);
  const seed = new Map(playerIds.map((id, i) => [id, i]));
  const rows = new Map<string, StandingRow>(
    playerIds.map((id) => [
      id,
      {
        playerId: id,
        played: 0,
        wins: 0,
        losses: 0,
        gamesFor: 0,
        gamesAgainst: 0,
        gameDiff: 0,
        points: 0,
        rank: 0,
      },
    ]),
  );

  const played = results.filter((m) => inPool.has(m.p1) && inPool.has(m.p2));
  for (const m of played) {
    const a = rows.get(m.p1);
    const b = rows.get(m.p2);
    if (!a || !b || m.games1 === m.games2) continue; // nul impossible au squash → ignoré
    a.played++;
    b.played++;
    a.gamesFor += m.games1;
    a.gamesAgainst += m.games2;
    b.gamesFor += m.games2;
    b.gamesAgainst += m.games1;
    if (m.games1 > m.games2) {
      a.wins++;
      b.losses++;
    } else {
      b.wins++;
      a.losses++;
    }
  }
  for (const r of rows.values()) {
    r.gameDiff = r.gamesFor - r.gamesAgainst;
    r.points = r.wins; // 1 point par victoire
  }

  // Mini-championnat : nb de victoires d'un joueur dans les matchs face à un ensemble donné.
  const winsAgainst = (id: string, group: Set<string>) =>
    played.reduce((acc, m) => {
      if (m.games1 === m.games2) return acc;
      const win = m.games1 > m.games2 ? m.p1 : m.p2;
      const lose = m.games1 > m.games2 ? m.p2 : m.p1;
      if (win === id && group.has(lose)) return acc + 1;
      return acc;
    }, 0);

  const sorted = [...rows.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    // Ex æquo aux points : mini-championnat (transitif car c'est un entier).
    const tied = new Set(
      [...rows.values()].filter((r) => r.points === a.points).map((r) => r.playerId),
    );
    const wa = winsAgainst(a.playerId, tied);
    const wb = winsAgainst(b.playerId, tied);
    if (wb !== wa) return wb - wa;
    if (b.gameDiff !== a.gameDiff) return b.gameDiff - a.gameDiff;
    if (b.gamesFor !== a.gamesFor) return b.gamesFor - a.gamesFor;
    return (seed.get(a.playerId) ?? 0) - (seed.get(b.playerId) ?? 0);
  });

  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

export interface Scheduled {
  key: string; // identifiant du match (opaque)
  wave: number; // vague de matchs joués en parallèle (0, 1, 2…)
  court: number; // 0..courts-1 (terrain = court + 1 à l'affichage)
  order: number; // ordre de passage global (0 = premier match)
}

/**
 * Planning des terrains : affecte chaque match à une VAGUE (matchs joués en parallèle) et
 * à un terrain, sans qu'un joueur soit dans deux matchs d'une même vague. Glouton : chaque
 * match prend la première vague compatible (< `courts` matchs, joueurs libres), sinon une
 * nouvelle vague. Donne la « liste des matchs » : terrain 1 → j1-j2, terrain 2 → j3-j4, etc.
 * (Les tournois à tableau planifient tour par tour ; cette fonction traite un lot de matchs
 * dont les joueurs sont déjà connus — typiquement une phase de poules ou un tour donné.)
 */
export function scheduleMatches(
  matches: { key: string; p1: string; p2: string }[],
  courts: number,
): Scheduled[] {
  const nbCourts = Math.max(1, courts);
  const waves: { players: Set<string>; count: number }[] = [];
  const out: Scheduled[] = [];

  for (const m of matches) {
    let wave = waves.findIndex(
      (w) => w.count < nbCourts && !w.players.has(m.p1) && !w.players.has(m.p2),
    );
    if (wave === -1) {
      waves.push({ players: new Set(), count: 0 });
      wave = waves.length - 1;
    }
    const w = waves[wave];
    const court = w.count;
    w.players.add(m.p1);
    w.players.add(m.p2);
    w.count++;
    out.push({ key: m.key, wave, court, order: 0 });
  }

  // Ordre de passage global : vague par vague, terrain 0..n dans chaque vague.
  out.sort((a, b) => a.wave - b.wave || a.court - b.court);
  out.forEach((s, i) => (s.order = i));
  return out;
}

// --- Tableau à classement intégral (repêchage complet) ---------------------
// Personne n'est éliminé : le perdant bascule dans une branche « classement » et continue.
// Chacun joue log2(P) tours (P = puissance de 2 ≥ N), on classe TOUS les joueurs 1→N.
// N non puissance de 2 → byes : les slots au-delà de N sont fictifs (le vrai joueur passe
// sans jouer). Un bye fait donc jouer 1 match de moins à celui qui le croise.

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Ordre de placement « tête de série » standard sur une taille puissance de 2 : la position
 * i affronte la position P−1−i au 1er tour (1 contre P, 2 contre P−1…). Ainsi les byes
 * (seeds les plus élevés) tombent face aux mieux classés.
 */
function seedOrder(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const m = order.length * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(m - 1 - s);
    }
    order = next;
  }
  return order;
}

export type BracketEntrant =
  | { kind: "seed"; seed: number } // seed -1 = BYE
  | { kind: "ref"; matchKey: string; take: "win" | "lose" };

export interface BracketMatch {
  key: string;
  round: number; // 0 = 1er tour
  slot: number; // position dans le tour
  branch: string; // chemin (vainqueurs/perdants), pour l'unicité de la clé
  rankLow: number; // meilleur rang que ce sous-tableau attribue
  rankHigh: number;
  placeLabel?: string; // posé sur les matchs « de placement » (2 rangs adjacents)
  a: BracketEntrant;
  b: BracketEntrant;
}

export interface PlacementRule {
  matchKey: string;
  take: "win" | "lose";
  rank: number; // rang (1..P) attribué au vainqueur/perdant de ce match
}

export interface PlacementBracket {
  size: number; // P = puissance de 2 ≥ N
  rounds: number; // log2(P) = matchs par joueur (hors byes)
  byes: number; // P − N
  matches: BracketMatch[];
  placements: PlacementRule[];
}

function placeLabelFor(rankLow: number): string {
  if (rankLow === 1) return "Finale";
  if (rankLow === 3) return "Petite finale (3e-4e place)";
  return `Places ${rankLow}-${rankLow + 1}`;
}

/** Génère la structure complète du tableau à repêchage pour `n` joueurs (6..16). */
export function placementBracket(n: number): PlacementBracket {
  const P = nextPow2(Math.max(2, n));
  const rounds = Math.round(Math.log2(P));
  const root: BracketEntrant[] = seedOrder(P).map((seed) => ({
    kind: "seed",
    seed: seed < n ? seed : -1, // seed ≥ n → BYE
  }));
  const matches: BracketMatch[] = [];
  const placements: PlacementRule[] = [];

  const build = (entrants: BracketEntrant[], round: number, branch: string, rankBase: number) => {
    const m = entrants.length;
    if (m === 1) return; // rang attribué par le match parent (via placements)
    const rankLow = rankBase;
    const rankHigh = rankBase + m - 1;
    const winners: BracketEntrant[] = [];
    const losers: BracketEntrant[] = [];
    for (let i = 0; i < m; i += 2) {
      const key = `${branch}-${round}-${i / 2}`;
      matches.push({
        key,
        round,
        slot: i / 2,
        branch,
        rankLow,
        rankHigh,
        a: entrants[i],
        b: entrants[i + 1],
        ...(m === 2 ? { placeLabel: placeLabelFor(rankLow) } : {}),
      });
      winners.push({ kind: "ref", matchKey: key, take: "win" });
      losers.push({ kind: "ref", matchKey: key, take: "lose" });
      if (m === 2) {
        placements.push({ matchKey: key, take: "win", rank: rankLow });
        placements.push({ matchKey: key, take: "lose", rank: rankLow + 1 });
      }
    }
    if (m > 2) {
      // Branche encodée entièrement (W pour vainqueurs, L pour perdants) → clés uniques :
      // sinon « perdant des vainqueurs » et « vainqueur des perdants » entreraient en collision.
      build(winners, round + 1, branch + "W", rankBase); // haut du classement
      build(losers, round + 1, branch + "L", rankBase + m / 2); // bas du classement (repêchage)
    }
  };
  build(root, 0, "M", 1);
  return { size: P, rounds, byes: P - n, matches, placements };
}

export interface BracketResolution {
  ranking: { seed: number; rank: number }[]; // joueurs réels, rangs 1..N (byes retirés)
  playedBySeed: Map<number, number>; // matchs RÉELLEMENT joués (hors byes) par joueur
  realMatches: number; // total de matchs réellement joués (hors byes)
  realMatchesByRound: number[]; // matchs réels par tour (pour estimer la durée)
}

/**
 * Déroule le tableau : `winnerOf(matchKey, seedA, seedB)` renvoie le SEED vainqueur d'un
 * match réel (jamais appelé quand un côté est un bye : le vrai joueur passe d'office).
 * Renvoie le classement final 1..N et le nombre de matchs réellement joués par joueur.
 */
export function resolveBracket(
  bracket: PlacementBracket,
  winnerOf: (matchKey: string, seedA: number, seedB: number) => number,
): BracketResolution {
  const byKey = new Map(bracket.matches.map((m) => [m.key, m]));
  const memo = new Map<string, { winner: number; loser: number }>();

  const entrantSeed = (e: BracketEntrant): number =>
    e.kind === "seed"
      ? e.seed
      : e.take === "win"
        ? resolve(e.matchKey).winner
        : resolve(e.matchKey).loser;

  function resolve(key: string): { winner: number; loser: number } {
    const cached = memo.get(key);
    if (cached) return cached;
    const m = byKey.get(key);
    if (!m) return { winner: -1, loser: -1 };
    const a = entrantSeed(m.a);
    const b = entrantSeed(m.b);
    let res: { winner: number; loser: number };
    if (a < 0 && b < 0) res = { winner: -1, loser: -1 };
    else if (a < 0) res = { winner: b, loser: a };
    else if (b < 0) res = { winner: a, loser: b };
    else {
      const w = winnerOf(key, a, b);
      res = w === b ? { winner: b, loser: a } : { winner: a, loser: b };
    }
    memo.set(key, res);
    return res;
  }

  // Compte les matchs réellement joués (deux vrais joueurs) par joueur et par tour.
  const played = new Map<number, number>();
  const byRound: number[] = Array(bracket.rounds).fill(0);
  let realMatches = 0;
  for (const m of bracket.matches) {
    const a = entrantSeed(m.a);
    const b = entrantSeed(m.b);
    if (a >= 0 && b >= 0) {
      played.set(a, (played.get(a) ?? 0) + 1);
      played.set(b, (played.get(b) ?? 0) + 1);
      realMatches++;
      byRound[m.round] = (byRound[m.round] ?? 0) + 1;
    }
  }

  const ranking = bracket.placements
    .map((p) => ({
      seed: p.take === "win" ? resolve(p.matchKey).winner : resolve(p.matchKey).loser,
      rank: p.rank,
    }))
    .filter((r) => r.seed >= 0)
    .sort((x, y) => x.rank - y.rank)
    .map((r, i) => ({ seed: r.seed, rank: i + 1 })); // re-rangs 1..N après retrait des byes

  return { ranking, playedBySeed: played, realMatches, realMatchesByRound: byRound };
}

export interface LiveBracketMatch {
  key: string;
  round: number;
  slot: number;
  branch: string;
  phase: "winners" | "classification";
  placeLabel?: string;
  p1: number | null; // seed, ou null si pas encore connu
  p2: number | null;
  status: "pending" | "bye" | "done";
  winnerSeed: number | null;
}

export interface LiveBracket {
  rounds: number;
  size: number;
  byes: number;
  matches: LiveBracketMatch[];
  ranking: { seed: number; rank: number }[] | null; // non null quand tout est joué
}

/**
 * État « en direct » du tableau à partir des résultats connus : `winnerSeed(key)` renvoie le
 * SEED vainqueur d'un match RÉEL joué, sinon null. Résout au mieux (byes + résultats connus)
 * pour donner, à l'instant T, les participants de chaque match, les byes et — quand tout est
 * joué — le classement final. Sert à l'affichage et à valider qu'un match est jouable.
 */
export function bracketLive(
  n: number,
  winnerSeed: (matchKey: string) => number | null,
): LiveBracket {
  const bracket = placementBracket(n);
  const byKey = new Map(bracket.matches.map((m) => [m.key, m]));
  const memo = new Map<string, { winner: number | null; loser: number | null }>();

  const entrant = (e: BracketEntrant): number | null => {
    if (e.kind === "seed") return e.seed; // -1 = bye
    const r = resolve(e.matchKey);
    return e.take === "win" ? r.winner : r.loser;
  };

  function resolve(key: string): { winner: number | null; loser: number | null } {
    const cached = memo.get(key);
    if (cached) return cached;
    const m = byKey.get(key);
    if (!m) return { winner: null, loser: null };
    const a = entrant(m.a);
    const b = entrant(m.b);
    let res: { winner: number | null; loser: number | null };
    if (a === null || b === null) res = { winner: null, loser: null };
    else if (a < 0 && b < 0) res = { winner: -1, loser: -1 };
    else if (a < 0) res = { winner: b, loser: a };
    else if (b < 0) res = { winner: a, loser: b };
    else {
      const w = winnerSeed(key);
      res = w === null ? { winner: null, loser: null } : w === b ? { winner: b, loser: a } : { winner: a, loser: b };
    }
    memo.set(key, res);
    return res;
  }

  const matches: LiveBracketMatch[] = bracket.matches.map((m) => {
    const a = entrant(m.a);
    const b = entrant(m.b);
    const known = a !== null && b !== null;
    const isBye = known && (a < 0 || b < 0);
    const bothReal = known && a >= 0 && b >= 0;
    const r = resolve(m.key);
    return {
      key: m.key,
      round: m.round,
      slot: m.slot ?? 0,
      branch: m.branch,
      phase: m.branch.includes("L") ? "classification" : "winners",
      placeLabel: m.placeLabel,
      p1: a !== null && a >= 0 ? a : null,
      p2: b !== null && b >= 0 ? b : null,
      status: isBye ? "bye" : bothReal && winnerSeed(m.key) !== null ? "done" : "pending",
      winnerSeed: r.winner !== null && r.winner >= 0 ? r.winner : null,
    };
  });

  const allResolved = bracket.matches.every((m) => resolve(m.key).winner !== null);
  const ranking = allResolved
    ? bracket.placements
        .map((p) => ({
          seed: p.take === "win" ? resolve(p.matchKey).winner : resolve(p.matchKey).loser,
          rank: p.rank,
        }))
        .filter((x): x is { seed: number; rank: number } => x.seed !== null && x.seed >= 0)
        .sort((x, y) => x.rank - y.rank)
        .map((x, i) => ({ seed: x.seed, rank: i + 1 }))
    : null;

  return { rounds: bracket.rounds, size: bracket.size, byes: bracket.byes, matches, ranking };
}

/**
 * Clés de TOUS les matchs situés en aval d'un match donné (ceux qui consomment, directement
 * ou transitivement, son vainqueur OU son perdant). Sert à invalider la cascade quand on
 * corrige un résultat : si le vainqueur change, les participants des matchs suivants changent
 * et leurs résultats déjà saisis deviennent caducs. Ne contient pas `key` lui-même.
 */
export function bracketDescendants(n: number, key: string): string[] {
  const bracket = placementBracket(n);
  // parentKey → clés des matchs qui le consomment (via une réf win/lose).
  const consumers = new Map<string, string[]>();
  for (const m of bracket.matches) {
    for (const e of [m.a, m.b]) {
      if (e.kind === "ref") {
        const arr = consumers.get(e.matchKey) ?? [];
        arr.push(m.key);
        consumers.set(e.matchKey, arr);
      }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>([key]);
  const queue = [key];
  while (queue.length) {
    const k = queue.shift() as string;
    for (const c of consumers.get(k) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
        queue.push(c);
      }
    }
  }
  return out;
}

// --- Choix de la formule ---------------------------------------------------
// Objectif n°1 (cf. cadrage) : TOUT LE MONDE JOUE LE MÊME NOMBRE DE MATCHS. On génère des
// candidats (poules de différentes tailles + tableau à repêchage) et on les classe par
// score lexicographique : écart max−min d'abord, puis proximité à la cible, puis durée.

export type FormatKind = "pools" | "bracket" | "pools_bracket";

export interface FormatProposal {
  kind: FormatKind;
  label: string;
  matchesPerPlayer: { min: number; max: number };
  avgMatchesPerPlayer: number;
  totalMatches: number;
  producesChampion: boolean;
  fullRanking: boolean; // classe-t-on 1..N ?
  estimatedMinutes: number;
  poolSizes?: number[];
  bracketByes?: number;
}

const DEFAULT_MATCH_MINUTES = 25;

/** Répartit `n` joueurs en `g` poules aussi égales que possible (tailles base ou base+1). */
function poolsOfCount(n: number, g: number): number[] {
  const base = Math.floor(n / g);
  const extra = n % g;
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));
}

function poolsLabel(sizes: number[]): string {
  const g = sizes.length;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const size = min === max ? `${min}` : `${min}-${max}`;
  return g === 1 ? `1 poule de ${size}` : `${g} poules de ${size}`;
}

function poolsProposal(n: number, sizes: number[], courts: number, matchMin: number): FormatProposal {
  const total = sizes.reduce((s, sz) => s + (sz * (sz - 1)) / 2, 0);
  const min = Math.min(...sizes) - 1;
  const max = Math.max(...sizes) - 1;
  const g = sizes.length;
  return {
    kind: "pools",
    label: poolsLabel(sizes),
    matchesPerPlayer: { min, max },
    avgMatchesPerPlayer: (2 * total) / n,
    totalMatches: total,
    producesChampion: g === 1, // une seule poule = round-robin intégral → un vainqueur
    fullRanking: g === 1,
    // Les matchs de poules se parallélisent librement sur les terrains.
    estimatedMinutes: Math.ceil(total / Math.max(1, courts)) * matchMin,
    poolSizes: sizes,
  };
}

function bracketProposal(n: number, courts: number, matchMin: number): FormatProposal {
  const b = placementBracket(n);
  const res = resolveBracket(b, (_k, a, bb) => Math.min(a, bb)); // simulation canonique
  const counts = Array.from({ length: n }, (_, s) => res.playedBySeed.get(s) ?? 0);
  // Durée : les tours sont SÉQUENTIELS (un tour dépend des résultats du précédent).
  const est = res.realMatchesByRound.reduce(
    (acc, c) => acc + Math.ceil(c / Math.max(1, courts)) * matchMin,
    0,
  );
  return {
    kind: "bracket",
    label: `Tableau à classement (${n})`,
    matchesPerPlayer: { min: Math.min(...counts), max: Math.max(...counts) },
    avgMatchesPerPlayer: (2 * res.realMatches) / n,
    totalMatches: res.realMatches,
    producesChampion: true,
    fullRanking: true,
    estimatedMinutes: est,
    bracketByes: b.byes,
  };
}

// Poids de l'inégalité de matchs. L'égalité est l'objectif n°1, mais PAS au point de
// choisir « 2 matchs pour tous » quand on en veut 4 : un écart de 1 « coûte » jusqu'à
// ~1,5 match d'éloignement à la cible. Au-delà, se rapprocher de la cible l'emporte.
const SPREAD_WEIGHT = 1.5;

// Score lexicographique (plus petit = meilleur) : 1) compromis égalité/proximité de la
// cible ; 2) plus court ; 3) à tout le reste égal, on préfère un classement complet.
function scoreOf(p: FormatProposal, target: number): number[] {
  const spread = p.matchesPerPlayer.max - p.matchesPerPlayer.min;
  const off = Math.abs(p.avgMatchesPerPlayer - target);
  return [spread * SPREAD_WEIGHT + off, p.estimatedMinutes, p.fullRanking ? 0 : 1];
}
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Propose les meilleures formules pour `n` joueurs (6..16) et une cible de `target` matchs
 * par joueur (2, 3 ou 4), triées de la meilleure à la moins bonne. Le tableau à repêchage
 * n'est retenu que lorsqu'il reste raisonnable (peu de byes : ≤ 25 % des places).
 */
export function proposeFormats(
  n: number,
  target: number,
  opts?: { courts?: number; matchMinutes?: number },
): FormatProposal[] {
  const courts = Math.max(1, opts?.courts ?? 2);
  const matchMin = opts?.matchMinutes ?? DEFAULT_MATCH_MINUTES;

  // Candidats « poules » : de 1 poule à des poules d'au moins 3 joueurs, taille ≤ 6.
  const poolCandidates: FormatProposal[] = [];
  for (let g = 1; g <= Math.floor(n / 3) || g === 1; g++) {
    const sizes = poolsOfCount(n, g);
    if (Math.min(...sizes) < 3 || Math.max(...sizes) > 6) continue;
    poolCandidates.push(poolsProposal(n, sizes, courts, matchMin));
  }
  // Filet : si aucune poule « propre », on garde une poule unique.
  if (poolCandidates.length === 0) {
    poolCandidates.push(poolsProposal(n, [n], courts, matchMin));
  }
  // On ne garde que la MEILLEURE configuration de poules (évite d'inonder de variantes).
  const bestPool = poolCandidates.reduce((best, p) =>
    lexLess(scoreOf(p, target), scoreOf(best, target)) ? p : best,
  );

  const proposals: FormatProposal[] = [bestPool];

  // Tableau à repêchage : proposé si les byes restent raisonnables (≤ 25 % des places).
  const P = nextPow2(Math.max(2, n));
  if ((P - n) * 4 <= P) {
    proposals.push(bracketProposal(n, courts, matchMin));
  }

  return proposals.sort((a, b) =>
    lexLess(scoreOf(a, target), scoreOf(b, target)) ? -1 : lexLess(scoreOf(b, target), scoreOf(a, target)) ? 1 : 0,
  );
}

/** La formule recommandée (première de `proposeFormats`). */
export function bestFormat(
  n: number,
  target: number,
  opts?: { courts?: number; matchMinutes?: number },
): FormatProposal {
  return proposeFormats(n, target, opts)[0];
}
