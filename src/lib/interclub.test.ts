import { describe, it, expect } from "vitest";
import {
  applyPoint,
  applyServe,
  checkGame,
  contrastRatio,
  describeSequenceProblem,
  gameWinner,
  isValidBestOf,
  isValidMatchCount,
  notifiesAt,
  parseFollowLevel,
  isPlayerColor,
  playerColor,
  playedGames,
  PLAYER_COLORS,
  replay,
  sequenceWinner,
  undo,
  validGameScore,
  validGameSequence,
  winGamesFor,
  type ScoreEvent,
  type Side,
} from "./interclub";

/**
 * Joue une suite d'échanges en répondant « à droite » à chaque fois que le moteur réclame un
 * carré. Permet d'écrire les tests en termes de qui gagne l'échange, sans noyer l'intention
 * sous les événements de service — ceux-ci ont leurs propres tests plus bas.
 */
function playSides(bestOf: number, sides: Side[], firstServer: Side = "home"): ScoreEvent[] {
  let ev: ScoreEvent[] = applyServe([], bestOf, firstServer, "right");
  for (const s of sides) {
    const st = replay(ev, bestOf);
    if (st.awaitingServeBox && st.serving) ev = applyServe(ev, bestOf, st.serving, "right");
    ev = applyPoint(ev, bestOf, s);
  }
  return ev;
}

const times = (n: number, s: Side): Side[] => Array.from({ length: n }, () => s);
/** Alterne home/away n fois chacun — mène à un score de parité (n-n). */
const rally = (n: number): Side[] => Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? "home" : "away"));

describe("winGamesFor", () => {
  it("au meilleur des 3 il faut 2 jeux, au meilleur des 5 il en faut 3", () => {
    expect(winGamesFor(3)).toBe(2);
    expect(winGamesFor(5)).toBe(3);
  });
});

describe("gameWinner", () => {
  it("désigne un vainqueur à 11 points avec au moins 2 d'écart", () => {
    expect(gameWinner({ home: 11, away: 9 })).toBe("home");
    expect(gameWinner({ home: 4, away: 11 })).toBe("away");
  });

  it("ne désigne personne à 11-10 : l'écart de 2 points n'est pas atteint", () => {
    expect(gameWinner({ home: 11, away: 10 })).toBeNull();
  });

  it("ne désigne personne sous 11 points, même avec un gros écart", () => {
    expect(gameWinner({ home: 10, away: 0 })).toBeNull();
  });

  it("désigne un vainqueur en prolongation", () => {
    expect(gameWinner({ home: 12, away: 10 })).toBe("home");
    expect(gameWinner({ home: 15, away: 17 })).toBe("away");
  });
});

describe("replay — déroulé d'un jeu", () => {
  it("un jeu se gagne à 11 points", () => {
    const st = replay(playSides(5, times(11, "home")), 5);
    expect(st.games).toEqual([{ home: 11, away: 0 }]);
    expect(st.gamesWon).toEqual({ home: 1, away: 0 });
    expect(st.current).toEqual({ home: 0, away: 0 });
    expect(st.status).toBe("live");
  });

  it("11-9 clôt le jeu", () => {
    const sides = [...rally(9), ...times(2, "home")]; // 9-9 puis deux points
    const st = replay(playSides(5, sides), 5);
    expect(st.games).toEqual([{ home: 11, away: 9 }]);
  });

  it("à 10-10 on joue la prolongation : 11-10 ne suffit pas, 12-10 conclut", () => {
    const base = rally(10); // 10-10
    const onze = replay(playSides(5, [...base, "home"]), 5);
    expect(onze.games).toEqual([]);
    expect(onze.current).toEqual({ home: 11, away: 10 });

    const douze = replay(playSides(5, [...base, "home", "home"]), 5);
    expect(douze.games).toEqual([{ home: 12, away: 10 }]);
  });

  it("supporte une prolongation longue (16-14)", () => {
    const st = replay(playSides(5, [...rally(14), ...times(2, "home")]), 5);
    expect(st.games).toEqual([{ home: 16, away: 14 }]);
  });
});

describe("replay — le service", () => {
  it("le serveur qui gagne l'échange garde le service et change de carré", () => {
    let ev = applyServe([], 5, "home", "right");
    ev = applyPoint(ev, 5, "home");
    const st = replay(ev, 5);
    expect(st.serving).toBe("home");
    expect(st.servingBox).toBe("left");
    expect(st.awaitingServeBox).toBe(false);
  });

  it("le carré continue d'alterner tant que le serveur enchaîne", () => {
    let ev = applyServe([], 5, "home", "right");
    ev = applyPoint(ev, 5, "home"); // -> left
    ev = applyPoint(ev, 5, "home"); // -> right
    expect(replay(ev, 5).servingBox).toBe("right");
  });

  it("à la reprise de service, le carré n'est PAS déduit : il est réclamé", () => {
    let ev = applyServe([], 5, "home", "right");
    ev = applyPoint(ev, 5, "away"); // l'adversaire gagne l'échange -> reprise de service
    const st = replay(ev, 5);
    expect(st.serving).toBe("away");
    expect(st.servingBox).toBeNull();
    expect(st.awaitingServeBox).toBe(true);
  });

  it("aucun point n'est accepté tant que le carré n'a pas été choisi", () => {
    let ev = applyServe([], 5, "home", "right");
    ev = applyPoint(ev, 5, "away");
    const bloque = applyPoint(ev, 5, "away");
    expect(bloque).toEqual(ev); // refusé : le journal n'a pas bougé

    const debloque = applyPoint(applyServe(ev, 5, "away", "left"), 5, "away");
    expect(debloque.length).toBe(ev.length + 2);
    expect(replay(debloque, 5).current).toEqual({ home: 0, away: 2 });
  });

  it("le vainqueur d'un jeu sert au jeu suivant, et choisit son carré", () => {
    const st = replay(playSides(5, times(11, "away")), 5);
    expect(st.serving).toBe("away");
    expect(st.servingBox).toBeNull();
    expect(st.awaitingServeBox).toBe(true);
  });

  it("ignore un point tant qu'aucun premier serveur n'est désigné", () => {
    const st = replay([{ t: "point", side: "home" }], 5);
    expect(st.current).toEqual({ home: 0, away: 0 });
    expect(st.status).toBe("pending");
  });
});

describe("replay — fin de match", () => {
  it("au meilleur des 3, deux jeux suffisent", () => {
    const st = replay(playSides(3, [...times(11, "home"), ...times(11, "home")]), 3);
    expect(st.status).toBe("done");
    expect(st.winner).toBe("home");
    expect(st.gamesWon).toEqual({ home: 2, away: 0 });
  });

  it("au meilleur des 5, deux jeux ne suffisent pas", () => {
    const st = replay(playSides(5, [...times(11, "home"), ...times(11, "home")]), 5);
    expect(st.status).toBe("live");
    expect(st.winner).toBeNull();
  });

  it("au meilleur des 5, le match se conclut au 3e jeu gagné", () => {
    const st = replay(playSides(5, times(33, "home")), 5);
    expect(st.status).toBe("done");
    expect(st.gamesWon).toEqual({ home: 3, away: 0 });
    expect(st.serving).toBeNull();
  });

  it("gagne un match en 5 jeux après avoir été mené 2-0", () => {
    const sides: Side[] = [
      ...times(11, "away"),
      ...times(11, "away"),
      ...times(11, "home"),
      ...times(11, "home"),
      ...times(11, "home"),
    ];
    const st = replay(playSides(5, sides), 5);
    expect(st.gamesWon).toEqual({ home: 3, away: 2 });
    expect(st.winner).toBe("home");
  });

  it("n'accepte plus rien une fois le match terminé", () => {
    const fini = playSides(3, times(22, "home"));
    expect(applyPoint(fini, 3, "away")).toEqual(fini);
    expect(applyServe(fini, 3, "away", "right")).toEqual(fini);
  });
});

describe("undo", () => {
  it("annuler puis rejouer redonne exactement l'état d'avant", () => {
    const avant = playSides(5, times(5, "home"));
    const apres = applyPoint(avant, 5, "away");
    expect(replay(undo(apres), 5)).toEqual(replay(avant, 5));
  });

  it("annule aussi un choix de carré", () => {
    let ev = applyServe([], 5, "home", "right");
    ev = applyPoint(ev, 5, "away"); // reprise de service
    const choisi = applyServe(ev, 5, "away", "left");
    expect(replay(choisi, 5).awaitingServeBox).toBe(false);
    expect(replay(undo(choisi), 5).awaitingServeBox).toBe(true);
  });

  it("annuler un journal vide ne casse rien", () => {
    expect(replay(undo([]), 5).status).toBe("pending");
  });

  it("remonte le score d'un jeu déjà clos si on annule le point décisif", () => {
    const gagnant = playSides(5, times(11, "home"));
    expect(replay(gagnant, 5).gamesWon).toEqual({ home: 1, away: 0 });
    const annule = replay(undo(gagnant), 5);
    expect(annule.gamesWon).toEqual({ home: 0, away: 0 });
    expect(annule.current).toEqual({ home: 10, away: 0 });
  });
});

describe("validGameScore", () => {
  it("accepte un score de jeu terminé", () => {
    expect(validGameScore(11, 9)).toBe(true);
    expect(validGameScore(12, 10)).toBe(true);
    expect(validGameScore(3, 11)).toBe(true);
  });

  it("refuse un jeu non terminé ou impossible", () => {
    expect(validGameScore(11, 10)).toBe(false);
    expect(validGameScore(9, 7)).toBe(false);
    expect(validGameScore(-1, 11)).toBe(false);
    expect(validGameScore(11.5, 2)).toBe(false);
  });
});

describe("validGameSequence — saisie a posteriori", () => {
  const g = (home: number, away: number) => ({ home, away });

  it("accepte un 3-0 au meilleur des 5", () => {
    expect(validGameSequence([g(11, 5), g(11, 8), g(11, 9)], 5)).toBe(true);
  });

  it("accepte un 3-2 au meilleur des 5", () => {
    expect(validGameSequence([g(11, 5), g(6, 11), g(11, 8), g(9, 11), g(12, 10)], 5)).toBe(true);
  });

  it("accepte un match pas encore joué", () => {
    expect(validGameSequence([], 5)).toBe(true);
  });

  it("refuse un jeu joué APRÈS la fin du match", () => {
    expect(validGameSequence([g(11, 5), g(11, 8), g(11, 9), g(11, 4)], 5)).toBe(false);
    expect(validGameSequence([g(11, 5), g(11, 8), g(11, 9)], 3)).toBe(false);
  });

  it("refuse un jeu non terminé au milieu de la suite", () => {
    expect(validGameSequence([g(11, 5), g(7, 4), g(11, 9)], 5)).toBe(false);
  });

  it("refuse plus de jeux que le format n'en permet", () => {
    expect(validGameSequence([g(11, 1), g(1, 11), g(11, 1), g(1, 11)], 3)).toBe(false);
  });

  it("désigne le vainqueur d'une suite complète, et personne sinon", () => {
    expect(sequenceWinner([g(11, 5), g(11, 8), g(11, 9)], 5)).toBe("home");
    expect(sequenceWinner([g(11, 5), g(6, 11)], 5)).toBeNull();
    expect(sequenceWinner([g(5, 11), g(6, 11)], 3)).toBe("away");
  });
});

describe("checkGame — saisie en cours", () => {
  const g = (home: number, away: number) => ({ home, away });

  it("une ligne fraîchement ouverte (0-0) est vide, pas fausse", () => {
    expect(checkGame(g(0, 0))).toBe("empty");
  });

  it("un jeu commencé est « en cours »", () => {
    expect(checkGame(g(7, 4))).toBe("in-progress");
    expect(checkGame(g(0, 3))).toBe("in-progress");
  });

  it("une prolongation en cours reste « en cours », pas impossible", () => {
    expect(checkGame(g(11, 10))).toBe("in-progress");
    expect(checkGame(g(13, 12))).toBe("in-progress");
  });

  it("reconnaît un jeu terminé, y compris 11-0", () => {
    expect(checkGame(g(11, 9))).toBe("finished");
    expect(checkGame(g(11, 0))).toBe("finished");
    expect(checkGame(g(12, 10))).toBe("finished");
  });

  it("refuse un score qui n'a pas pu exister : au-delà de 11, l'écart ne dépasse jamais 2", () => {
    expect(checkGame(g(12, 0))).toBe("impossible");
    expect(checkGame(g(15, 3))).toBe("impossible");
  });

  it("refuse un score négatif ou décimal", () => {
    expect(checkGame(g(-1, 5))).toBe("impossible");
    expect(checkGame(g(2.5, 5))).toBe("impossible");
  });
});

describe("describeSequenceProblem — messages de saisie", () => {
  const g = (home: number, away: number) => ({ home, away });

  it("ne signale RIEN sur une ligne qu'on vient d'ouvrir", () => {
    expect(describeSequenceProblem([g(0, 0)], 5)).toBeNull();
    expect(describeSequenceProblem([g(11, 5), g(0, 0)], 5)).toBeNull();
  });

  it("ne signale rien sur une suite valide", () => {
    expect(describeSequenceProblem([g(11, 5), g(9, 11), g(11, 8)], 5)).toBeNull();
  });

  it("nomme le jeu non terminé plutôt que de réciter le règlement", () => {
    expect(describeSequenceProblem([g(11, 5), g(7, 4)], 5)).toMatch(/Jeu 2/);
    expect(describeSequenceProblem([g(11, 5), g(7, 4)], 5)).toMatch(/pas encore terminé/);
  });

  it("nomme le jeu impossible", () => {
    expect(describeSequenceProblem([g(15, 3)], 5)).toMatch(/Jeu 1/);
    expect(describeSequenceProblem([g(15, 3)], 5)).toMatch(/impossible/);
  });

  it("signale un jeu joué après la fin du match", () => {
    const p = describeSequenceProblem([g(11, 1), g(11, 2), g(11, 3), g(11, 4)], 5);
    expect(p).toMatch(/déjà gagné avant le jeu 4/);
  });

  it("signale un dépassement du format", () => {
    const six = [g(11, 1), g(1, 11), g(11, 1), g(1, 11), g(11, 1), g(1, 11)];
    expect(describeSequenceProblem(six, 5)).toMatch(/pas plus de 5/);
  });
});

describe("playedGames", () => {
  const g = (home: number, away: number) => ({ home, away });

  it("écarte les lignes vides et ne garde que les jeux terminés", () => {
    expect(playedGames([g(11, 5), g(0, 0), g(9, 11), g(0, 0)])).toEqual([g(11, 5), g(9, 11)]);
  });

  it("écarte aussi un jeu commencé mais pas fini", () => {
    expect(playedGames([g(11, 5), g(7, 4)])).toEqual([g(11, 5)]);
  });
});

describe("formats de rencontre", () => {
  it("n'accepte que le meilleur des 3 ou des 5", () => {
    expect(isValidBestOf(3)).toBe(true);
    expect(isValidBestOf(5)).toBe(true);
    expect(isValidBestOf(4)).toBe(false);
    expect(isValidBestOf("5")).toBe(false);
  });

  it("borne le nombre de simples d'une rencontre", () => {
    expect(isValidMatchCount(4)).toBe(true);
    expect(isValidMatchCount(0)).toBe(false);
    expect(isValidMatchCount(9)).toBe(false);
    expect(isValidMatchCount(2.5)).toBe(false);
  });
});

describe("couleurs de joueur", () => {
  it("chaque couleur respecte le contraste AA (4.5:1) entre son fond et son encre", () => {
    for (const c of PLAYER_COLORS) {
      expect(contrastRatio(c.bg, c.fg), `${c.key} (${c.bg} sur ${c.fg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("les clés sont uniques", () => {
    const keys = PLAYER_COLORS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("l'absence de couleur est valide — elle est facultative", () => {
    expect(isPlayerColor(null)).toBe(true);
    expect(isPlayerColor(undefined)).toBe(true);
    expect(playerColor(null)).toBeNull();
  });

  it("refuse une couleur hors palette : le contraste ne serait plus garanti", () => {
    expect(isPlayerColor("#ff00ff")).toBe(false);
    expect(isPlayerColor("turquoise")).toBe(false);
    expect(playerColor("turquoise")).toBeNull();
  });

  it("retrouve une couleur de la palette", () => {
    expect(playerColor("rouge")?.bg).toBe("#c62828");
  });
});

describe("contrastRatio", () => {
  it("noir sur blanc vaut 21, une couleur sur elle-même vaut 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#c62828", "#c62828")).toBeCloseTo(1, 5);
  });
});

describe("niveaux d'abonnement", () => {
  it("lit un niveau valide et rejette le reste", () => {
    expect(parseFollowLevel("highlights")).toBe("highlights");
    expect(parseFollowLevel("tout")).toBeNull();
    expect(parseFollowLevel(null)).toBeNull();
  });

  it("un abonné « détaillé » reçoit aussi les temps forts et le résultat", () => {
    expect(notifiesAt("detailed", "result")).toBe(true);
    expect(notifiesAt("detailed", "highlights")).toBe(true);
  });

  it("un abonné « résultat » ne reçoit pas les temps forts", () => {
    expect(notifiesAt("result", "highlights")).toBe(false);
    expect(notifiesAt("result", "result")).toBe(true);
  });
});
