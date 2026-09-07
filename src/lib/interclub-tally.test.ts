import { describe, it, expect } from "vitest";
import { runningTally, type TallyMatch } from "./interclub";

// LE COMPTEUR D'AVANCE, pendant que la rencontre se joue.
//
// Ce que ces essais protègent tient en une phrase : à quatre simples, un 2-2 vaut deux points
// de classement ou un seul selon l'average — et le compteur doit être JUSTE au point près,
// sinon il vaut mieux ne rien afficher.

/** Un simple TERMINÉ, avec son détail jeu par jeu. */
const fini = (games: [number, number][]): TallyMatch => ({
  status: "done",
  gamesHome: games.filter(([h, a]) => h > a).length,
  gamesAway: games.filter(([h, a]) => a > h).length,
  games: games.map(([home, away]) => ({ home, away })),
  live: null,
});

/** Un simple EN COURS : ses jeux finis, plus le jeu que le marqueur est en train de compter. */
const enCours = (games: [number, number][], current: [number, number]): TallyMatch => ({
  status: "live",
  gamesHome: games.length ? games.filter(([h, a]) => h > a).length : null,
  gamesAway: games.length ? games.filter(([h, a]) => a > h).length : null,
  games: games.map(([home, away]) => ({ home, away })),
  live: { current: { home: current[0], away: current[1] } },
});

const pasCommence = (): TallyMatch => ({
  status: "pending",
  gamesHome: null,
  gamesAway: null,
  games: [],
  live: null,
});

describe("runningTally — ce qu'il compte", () => {
  it("compte les jeux des matchs EN COURS, pas seulement des matchs finis", () => {
    const t = runningTally(4, [
      fini([[11, 5], [11, 7], [9, 11], [11, 8]]), // gagné 3-1
      enCours([[11, 9], [8, 11]], [5, 3]), // 1-1 en cours
      pasCommence(),
      pasCommence(),
    ]);
    // Le simple en cours apporte SES jeux : c'est là que l'average bouge pendant la soirée.
    expect(t.games).toEqual({ home: 4, away: 2 });
    // …mais pas son match, qui n'est pas gagné.
    expect(t.matches).toEqual({ home: 1, away: 0 });
  });

  it("compte les points du JEU EN COURS, qui n'est encore gagné par personne", () => {
    const t = runningTally(4, [enCours([[11, 9]], [5, 3]), pasCommence(), pasCommence(), pasCommence()]);
    expect(t.rallies).toEqual({ home: 16, away: 12 });
    expect(t.games).toEqual({ home: 1, away: 0 });
  });

  it("ne compte pas un match mené 1-0 comme un match gagné", () => {
    const t = runningTally(4, [
      enCours([[11, 9]], [0, 0]),
      enCours([[11, 9]], [0, 0]),
      enCours([[11, 9]], [0, 0]),
      enCours([[3, 11]], [0, 0]),
    ]);
    expect(t.matches).toEqual({ home: 0, away: 0 });
    expect(t.pending).toBe(4);
  });

  it("refuse le total des points dès qu'un simple est saisi sans son détail", () => {
    // Un « 3-1 » sans jeu par jeu : le total serait PARTIEL, et c'est le chiffre qui départage.
    const t = runningTally(4, [
      { status: "done", gamesHome: 3, gamesAway: 1, games: [], live: null },
      fini([[11, 5], [11, 7], [11, 9]]),
      pasCommence(),
      pasCommence(),
    ]);
    expect(t.rallies).toBeNull();
    // Les JEUX, eux, restent justes : la colonne suffit à les connaître.
    expect(t.games).toEqual({ home: 6, away: 1 });
  });
});

describe("runningTally — ce que le compte peut encore décider", () => {
  it("voit le nul atteignable à deux simples restants sur 1-1", () => {
    const t = runningTally(4, [
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[5, 11], [7, 11], [9, 11]]),
      pasCommence(),
      pasCommence(),
    ]);
    expect(t.pending).toBe(2);
    expect(t.drawReachable).toBe(true);
    expect(t.drawAt).toBe(2);
    expect(t.settled).toBeNull();
  });

  it("refuse le nul à UN seul simple restant sur 1-1 — la parité l'interdit", () => {
    // C'est la moitié du sujet : l'écart (0) tient dans ce qui reste (1), mais quelqu'un
    // gagnera forcément ce match. Annoncer un départage à l'average serait faux.
    const t = runningTally(3, [
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[5, 11], [7, 11], [9, 11]]),
      pasCommence(),
    ]);
    expect(t.pending).toBe(1);
    expect(t.drawReachable).toBe(false);
    expect(t.drawAt).toBeNull();
    expect(t.settled).toBeNull();
  });

  it("voit le nul encore atteignable à 2-0 quand il reste deux simples", () => {
    const t = runningTally(4, [
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[11, 5], [11, 7], [11, 9]]),
      pasCommence(),
      pasCommence(),
    ]);
    expect(t.drawReachable).toBe(true);
    expect(t.drawAt).toBe(2);
    expect(t.settled).toBeNull();
  });

  it("déclare la victoire acquise quand ce qui reste ne peut plus la reprendre", () => {
    const t = runningTally(4, [
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[11, 5], [11, 7], [11, 9]]),
      enCours([], [4, 2]),
    ]);
    expect(t.settled).toBe("win");
    expect(t.drawReachable).toBe(false);
  });

  it("déclare la défaite acquise de la même façon", () => {
    const t = runningTally(4, [
      fini([[5, 11], [7, 11], [9, 11]]),
      fini([[5, 11], [7, 11], [9, 11]]),
      fini([[5, 11], [7, 11], [9, 11]]),
      pasCommence(),
    ]);
    expect(t.settled).toBe("loss");
  });

  it("n'annonce jamais de nul dans une rencontre à cinq simples", () => {
    const t = runningTally(5, [pasCommence(), pasCommence(), pasCommence(), pasCommence(), pasCommence()]);
    expect(t.drawReachable).toBe(false);
  });

  it("ne compte pas deux fois les points d'un instantané resté sur un match terminé", () => {
    const t = runningTally(4, [
      { ...fini([[11, 5], [11, 7], [11, 9]]), live: { current: { home: 7, away: 3 } } },
      pasCommence(),
      pasCommence(),
      pasCommence(),
    ]);
    expect(t.rallies).toEqual({ home: 33, away: 21 });
  });
});

describe("runningTally — quand la charge utile est en retard d'un déploiement", () => {
  it("retombe sur le nombre de simples fournis plutôt que d'afficher NaN", () => {
    // Le panneau du direct lit une réponse mise en cache : une entrée écrite par le
    // déploiement précédent n'a pas encore le champ `matchCount`.
    const t = runningTally(undefined as unknown as number, [
      fini([[11, 5], [11, 7], [11, 9]]),
      fini([[5, 11], [7, 11], [9, 11]]),
      pasCommence(),
      pasCommence(),
    ]);
    expect(t.pending).toBe(2);
    expect(t.drawReachable).toBe(true);
    expect(t.drawAt).toBe(2);
  });
});
