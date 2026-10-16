import type { CheckReport, PlayerCheck, ScoreCheck } from "@/lib/captain-check";

// Le rapport de vérification de Yvette 2 – Verrieres 3 du 15/10/2026 (rencontre squashnet
// 1893481), tel que l'appli le tient : notre joueur toujours en `home`, les jeux de NOTRE point
// de vue. Il va avec `capitaine-2027-1893481-saisie.html`, le formulaire de la même rencontre.

const joueur = (order: number, side: "home" | "away", fedName: string | null): PlayerCheck => ({
  order,
  side,
  name: fedName ?? "Inconnu",
  verdict: fedName ? "found" : "unknown",
  fedName,
  clt: null,
  rangM: null,
  licence: null,
  club: null,
  hint: null,
});

const simple = (order: number, games: [number, number][]): ScoreCheck => {
  const gh = games.filter(([a, b]) => a > b).length;
  return {
    order,
    ok: true,
    problem: null,
    gamesHome: gh,
    gamesAway: games.length - gh,
    winner: gh === 3 ? "home" : "away",
    games: games.map(([home, away]) => ({ home, away })),
  };
};

export function rapport1893481(): CheckReport {
  return {
    checkedAt: "2026-10-16T08:00:00.000Z",
    players: [
      joueur(1, "home", "PLENAT THOMAS"),
      joueur(1, "away", "THUILLIER GUILLAUME"),
      joueur(2, "home", "COURTAUT JEROME"),
      joueur(2, "away", "BEZELGA CHRISTOPHE"),
      joueur(3, "home", "WANLIN ERIC"),
      joueur(3, "away", "LOUVEAU FLORENT"),
      joueur(4, "home", "VICART DAMIEN"),
      joueur(4, "away", "DOUSSERON PASCAL"),
    ],
    scores: [
      simple(1, [[9, 11], [3, 11], [9, 11]]),
      simple(2, [[9, 11], [6, 11], [5, 11]]),
      simple(3, [[11, 3], [11, 7], [11, 4]]),
      simple(4, [[11, 8], [0, 11], [3, 11], [2, 11]]),
    ],
    tie: { ok: true, home: 1, away: 3, undecided: 0, problem: null },
    awayOrder: { status: "ok", problem: null },
  };
}
