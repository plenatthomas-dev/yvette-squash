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
  COLOR_PRESETS,
  colorDistance,
  colorsTooClose,
  MIN_DISTINCT_DELTA_E,
  inkFor,
  isColorValue,
  normalizeColor,
  playedGames,
  resolveColor,
  seedEvents,
  replay,
  sequenceWinner,
  undo,
  validGameSequence,
  winGamesFor,
  type ScoreEvent,
  type Side,
  hexToHsv,
  hsvToHex,
  lineupComplete,
  UNSET_PLAYER,
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

describe("seedEvents — reprendre un match déjà entamé", () => {
  const g = (home: number, away: number) => ({ home, away });

  it("reproduit fidèlement le score de chaque jeu", () => {
    const games = [g(11, 9), g(6, 11), g(12, 10)];
    const st = replay(seedEvents(games, 5), 5);
    expect(st.games).toEqual(games);
    expect(st.gamesWon).toEqual({ home: 2, away: 1 });
  });

  it("ne clôt pas un jeu avant son dernier point (11-0 compris)", () => {
    expect(replay(seedEvents([g(11, 0)], 5), 5).games).toEqual([g(11, 0)]);
    expect(replay(seedEvents([g(0, 11)], 5), 5).games).toEqual([g(0, 11)]);
  });

  it("reconstitue un match terminé, et le laisse terminé", () => {
    const st = replay(seedEvents([g(11, 5), g(11, 8), g(11, 9)], 5), 5);
    expect(st.status).toBe("done");
    expect(st.winner).toBe("home");
  });

  it("ignore les jeux non terminés plutôt que d'inventer un score", () => {
    expect(replay(seedEvents([g(11, 5), g(7, 4)], 5), 5).games).toEqual([g(11, 5)]);
  });

  it("laisse un match en cours dans un état où l'on peut reprendre le marquage", () => {
    const st = replay(seedEvents([g(11, 5)], 5), 5);
    expect(st.status).toBe("live");
    // Le vainqueur du jeu sert au suivant et doit choisir son carré.
    expect(st.awaitingServeBox).toBe(true);
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

describe("couleurs de joueur — choix libre, encre calculée", () => {
  it("garantit le contraste AA sur TOUT le cube RGB, pas seulement sur une palette curée", () => {
    // C'est la propriété qui autorise le choix libre : en n'utilisant que du blanc ou du noir
    // PUR comme encre, le pire cas possible atteint 4.58:1, au-dessus des 4.5 exigés. On
    // balaie le cube par pas de 17 (16^3 = 4096 couleurs) plutôt que de faire confiance.
    let worst = Infinity;
    let worstHex = "";
    const hx = (n: number) => n.toString(16).padStart(2, "0");
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const bg = `#${hx(r)}${hx(g)}${hx(b)}`;
          const ratio = contrastRatio(bg, inkFor(bg));
          if (ratio < worst) {
            worst = ratio;
            worstHex = bg;
          }
        }
      }
    }
    expect(worst, `pire cas sur ${worstHex}`).toBeGreaterThanOrEqual(4.5);
  });

  it("pose de l'encre claire sur un fond sombre, et l'inverse", () => {
    expect(inkFor("#000000")).toBe("#ffffff");
    expect(inkFor("#ffffff")).toBe("#000000");
    expect(inkFor("#1a237e")).toBe("#ffffff");
    expect(inkFor("#fdd835")).toBe("#000000");
  });

  it("accepte n'importe quel #rrggbb, avec ou sans dièse, quelle que soit la casse", () => {
    expect(normalizeColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeColor("a1b2c3")).toBe("#a1b2c3");
    expect(normalizeColor("  #FFF000  ")).toBe("#fff000");
  });

  it("comprend encore les clés de l'ancienne palette fermée", () => {
    // Des lignes saisies avant le passage au choix libre les portent toujours en base.
    expect(normalizeColor("rouge")).toBe("#c62828");
    expect(normalizeColor("BLEU")).toBe("#1565c0");
  });

  it("refuse ce qui n'est pas une couleur", () => {
    expect(normalizeColor("bleu-ciel")).toBeNull();
    expect(normalizeColor("#12345")).toBeNull();
    expect(normalizeColor("rgb(1,2,3)")).toBeNull();
    expect(normalizeColor(42)).toBeNull();
    expect(normalizeColor(null)).toBeNull();
  });

  it("l'absence de couleur reste valide — elle est facultative", () => {
    expect(isColorValue(null)).toBe(true);
    expect(isColorValue(undefined)).toBe(true);
    expect(isColorValue("")).toBe(true);
    expect(isColorValue("#a1b2c3")).toBe(true);
    expect(isColorValue("turquoise-fluo")).toBe(false);
  });

  it("résout une couleur en paire fond/encre cohérente", () => {
    const c = resolveColor("#c62828");
    expect(c?.bg).toBe("#c62828");
    expect(c?.fg).toBe(inkFor("#c62828"));
    expect(c?.label).toBe("Rouge"); // un raccourci connu garde son nom
    expect(resolveColor("#123456")?.label).toBe("#123456"); // sinon on affiche le code
    expect(resolveColor(null)).toBeNull();
  });

  it("les raccourcis proposés sont des couleurs valides et distinctes", () => {
    const hexes = COLOR_PRESETS.map((c) => c.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const c of COLOR_PRESETS) {
      expect(normalizeColor(c.hex), c.key).toBe(c.hex);
      expect(contrastRatio(c.hex, inkFor(c.hex)), c.key).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("distinguer deux maillots", () => {
  it("sépare largement deux couleurs franches", () => {
    expect(colorDistance("#c62828", "#1565c0")).toBeGreaterThan(80);
    expect(colorsTooClose("#c62828", "#1565c0")).toBe(false);
  });

  it("repère deux nuances voisines, que le choix libre rend possibles", () => {
    // C'est le coût du choix libre : deux joueurs peuvent prendre deux bleus qui ne
    // distinguent plus rien. La palette fermée l'empêchait par construction.
    expect(colorsTooClose("#1565c0", "#1976d2")).toBe(true);
    expect(colorsTooClose("#c62828", "#d32f2f")).toBe(true);
  });

  it("laisse passer toutes les paires des raccourcis proposés", () => {
    // Le seuil est calibré sur eux : si l'un d'eux déclenchait l'avertissement, c'est le
    // seuil ou la palette qu'il faudrait revoir.
    for (const a of COLOR_PRESETS) {
      for (const b of COLOR_PRESETS) {
        if (a.key === b.key) continue;
        expect(colorsTooClose(a.hex, b.hex), `${a.key} / ${b.key}`).toBe(false);
      }
    }
  });

  it("ne dit rien quand une couleur manque : ne pas choisir est un choix valide", () => {
    expect(colorsTooClose("#c62828", null)).toBe(false);
    expect(colorsTooClose(null, null)).toBe(false);
    expect(colorsTooClose("#c62828", "")).toBe(false);
  });

  it("comprend les clés de l'ancienne palette comme le reste du module", () => {
    expect(colorsTooClose("rouge", "#c62828")).toBe(true);
  });

  it("une couleur est à distance nulle d'elle-même", () => {
    expect(colorDistance("#123456", "#123456")).toBeCloseTo(0, 6);
    expect(MIN_DISTINCT_DELTA_E).toBeGreaterThan(0);
  });
});

describe("contrastRatio", () => {
  it("noir sur blanc vaut 21, une couleur sur elle-même vaut 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#c62828", "#c62828")).toBeCloseTo(1, 5);
  });
});

describe("niveaux d'abonnement", () => {
  it("un abonné « détaillé » reçoit aussi les temps forts et le résultat", () => {
    expect(notifiesAt("detailed", "result")).toBe(true);
    expect(notifiesAt("detailed", "highlights")).toBe(true);
  });

  it("un abonné « résultat » ne reçoit pas les temps forts", () => {
    expect(notifiesAt("result", "highlights")).toBe(false);
    expect(notifiesAt("result", "result")).toBe(true);
  });
});

describe("seedEvents — ne désigne AUCUN serveur quand il n'y a rien à reproduire", () => {
  const g = (home: number, away: number) => ({ home, away });

  // Le premier service se tire au sort sur le terrain. L'appli ne peut pas le savoir, et le
  // supposer se trompe une fois sur deux — sur la seule information que le marqueur avait à
  // saisir. Inventer le déroulé de jeux DÉJÀ joués est autre chose : leur serveur n'importe plus.
  it("rend un journal vide sur un match vierge, pour que l'écran puisse demander qui engage", () => {
    expect(seedEvents([], 5)).toEqual([]);
    const st = replay(seedEvents([], 5), 5);
    expect(st.serving).toBeNull();
    expect(st.status).toBe("pending");
  });

  it("en fait autant quand le seul jeu fourni n'est pas terminé — il n'y a rien à reproduire", () => {
    expect(seedEvents([g(7, 4)], 5)).toEqual([]);
  });

  it("désigne en revanche un serveur dès qu'un jeu est reproductible", () => {
    // Le déroulé est inventé, c'est assumé : seul le score de chaque jeu terminé est fidèle.
    const st = replay(seedEvents([g(11, 5)], 5), 5);
    expect(st.games).toEqual([g(11, 5)]);
    expect(st.serving).not.toBeNull();
  });
});

describe("hexToHsv / hsvToHex — l'aller-retour doit se refermer", () => {
  it("retrouve chaque couleur du nuancier après un aller-retour", () => {
    // C'est la propriété qui compte : le sélecteur lit une couleur, la décompose en trois
    // curseurs, et doit rendre la MÊME couleur tant qu'on n'a touché à rien.
    for (const c of COLOR_PRESETS) {
      const hsv = hexToHsv(c.hex);
      expect(hsv).not.toBeNull();
      expect(hsvToHex(hsv!)).toBe(c.hex);
    }
  });

  it("place les primaires là où on les attend", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv("#0000ff")).toEqual({ h: 240, s: 1, v: 1 });
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
  });

  it("rend une teinte de 0 sur un gris, plutôt que NaN — le curseur doit se poser quelque part", () => {
    expect(hexToHsv("#808080")).toEqual({ h: 0, s: 0, v: 128 / 255 });
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
  });

  it("borne les entrées hors domaine au lieu de produire une couleur invalide", () => {
    expect(hsvToHex({ h: 720, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -60, s: 2, v: 5 })).toBe("#ff00ff");
    expect(/^#[0-9a-f]{6}$/.test(hsvToHex({ h: 33, s: -1, v: -1 }))).toBe(true);
  });

  it("refuse ce qui n'est pas un #rrggbb", () => {
    expect(hexToHsv("rouge")).toBeNull();
    expect(hexToHsv("#fff")).toBeNull();
  });
});

describe("lineupComplete", () => {
  it("faux si l'un des deux noms est encore « à désigner »", () => {
    expect(lineupComplete(UNSET_PLAYER, "Dupont")).toBe(false);
    expect(lineupComplete("Thomas", UNSET_PLAYER)).toBe(false);
    expect(lineupComplete(UNSET_PLAYER, UNSET_PLAYER)).toBe(false);
  });

  it("vrai quand les deux joueurs sont désignés", () => {
    expect(lineupComplete("Thomas", "Dupont")).toBe(true);
  });
});
