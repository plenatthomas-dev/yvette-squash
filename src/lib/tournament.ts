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
