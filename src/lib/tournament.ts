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

  // Compte les matchs réellement joués (deux vrais joueurs) par joueur.
  const played = new Map<number, number>();
  for (const m of bracket.matches) {
    const a = entrantSeed(m.a);
    const b = entrantSeed(m.b);
    if (a >= 0 && b >= 0) {
      played.set(a, (played.get(a) ?? 0) + 1);
      played.set(b, (played.get(b) ?? 0) + 1);
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

  return { ranking, playedBySeed: played };
}
