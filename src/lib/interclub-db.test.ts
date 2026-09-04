import { describe, it, expect } from "vitest";
import {
  derivedStatus,
  fixtureScore,
  parseLive,
  scorerIsStale,
  SCORER_STALE_MS,
  staleGamesReason,
  tieOutcome,
} from "./interclub-db";

describe("fixtureScore", () => {
  it("compte les matchs gagnés de chaque côté", () => {
    expect(
      fixtureScore([
        { gamesHome: 3, gamesAway: 0, status: "done" },
        { gamesHome: 1, gamesAway: 3, status: "done" },
        { gamesHome: 3, gamesAway: 2, status: "done" },
      ]),
    ).toEqual({ home: 2, away: 1 });
  });

  it("ignore les matchs sans résultat : une rencontre en cours affiche 1-0, pas 1-3", () => {
    expect(
      fixtureScore([
        { gamesHome: 3, gamesAway: 0, status: "done" },
        { gamesHome: null, gamesAway: null, status: "pending" },
        { gamesHome: null, gamesAway: null, status: "pending" },
      ]),
    ).toEqual({ home: 1, away: 0 });
  });

  it("ne compte PAS un match mené 1-0 encore en cours", () => {
    // `gamesHome` est renseignée dès le premier jeu joué. S'y fier ferait passer un match en
    // cours pour un match gagné — et une soirée à deux terrains pour une rencontre pliée.
    expect(
      fixtureScore([
        { gamesHome: 1, gamesAway: 0, status: "live" },
        { gamesHome: 1, gamesAway: 0, status: "live" },
        { gamesHome: 0, gamesAway: 1, status: "live" },
        { gamesHome: 1, gamesAway: 0, status: "live" },
      ]),
    ).toEqual({ home: 0, away: 0 });
  });
});

describe("derivedStatus", () => {
  const pending = { gamesHome: null, status: "pending" };
  const done = { gamesHome: 3, status: "done" };

  it("programmée tant qu'aucun match n'a commencé", () => {
    expect(derivedStatus(4, [pending, pending, pending, pending])).toBe("scheduled");
  });

  it("en cours dès qu'un match est terminé mais que les autres restent à jouer", () => {
    expect(derivedStatus(4, [done, pending, pending, pending])).toBe("live");
  });

  it("en cours dès qu'un match est marqué en direct, même sans résultat", () => {
    expect(derivedStatus(4, [{ gamesHome: null, status: "live" }, pending, pending, pending])).toBe("live");
  });

  it("terminée quand tous les matchs sont terminés", () => {
    expect(derivedStatus(4, [done, done, done, done])).toBe("done");
  });

  it("ne se déclare pas terminée si des matchs manquent encore à l'appel", () => {
    expect(derivedStatus(4, [done, done])).toBe("live");
  });

  it("ne confond PAS « un jeu joué » avec « match terminé »", () => {
    // Le déroulé ordinaire d'une soirée à deux terrains : les quatre matchs ont chacun bouclé
    // un jeu. Se fier à `gamesHome !== null` déclarait la rencontre terminée à cet instant —
    // le direct se figeait et la notification de résultat partait à tous les abonnés.
    const unJeuJoue = { gamesHome: 1, status: "live" };
    expect(derivedStatus(4, [unJeuJoue, unJeuJoue, unJeuJoue, unJeuJoue])).toBe("live");
  });
});

describe("scorerIsStale", () => {
  const now = new Date("2026-09-03T21:00:00Z");

  it("une prise sans horodatage est périmée", () => {
    expect(scorerIsStale(null, now)).toBe(true);
  });

  it("une prise récente tient", () => {
    expect(scorerIsStale(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it("une prise abandonnée se libère, sinon un téléphone à plat gèlerait le match", () => {
    expect(scorerIsStale(new Date(now.getTime() - SCORER_STALE_MS - 1000), now)).toBe(true);
  });

  it("les 30 minutes sont une VRAIE borne, qu'un tiers ne peut pas repousser", () => {
    // On se fie à `scorerClaimedAt`, écrit par la seule activité du marqueur, et jamais à
    // `updatedAt` : ce dernier est rafraîchi par n'importe quelle écriture sur la ligne — un
    // capitaine qui corrige le nom de l'adversaire reconduisait alors une prise morte, et
    // chaque nouvelle correction la reconduisait encore.
    const prisAbandonnee = new Date(now.getTime() - SCORER_STALE_MS - 1000);
    expect(scorerIsStale(prisAbandonnee, now)).toBe(true);
  });
});

describe("parseLive", () => {
  it("relit un instantané valide", () => {
    const raw = JSON.stringify({
      current: { home: 7, away: 4 },
      serving: "home",
      servingBox: "left",
      awaitingServeBox: false,
    });
    expect(parseLive(raw)).toEqual({
      current: { home: 7, away: 4 },
      serving: "home",
      servingBox: "left",
      awaitingServeBox: false,
    });
  });

  it("renvoie null sur du JSON cassé plutôt que d'inventer un état", () => {
    expect(parseLive("{pas du json")).toBeNull();
    expect(parseLive(null)).toBeNull();
  });

  it("renvoie null si le score est absurde", () => {
    expect(parseLive(JSON.stringify({ current: { home: -1, away: 2 } }))).toBeNull();
    expect(parseLive(JSON.stringify({ current: { home: "sept", away: 2 } }))).toBeNull();
  });

  it("neutralise un serveur ou un carré inconnu", () => {
    const raw = JSON.stringify({ current: { home: 0, away: 0 }, serving: "milieu", servingBox: "haut" });
    expect(parseLive(raw)).toMatchObject({ serving: null, servingBox: null });
  });
});

describe("parseLive — la borne haute, que la route affirmait déjà", () => {
  const instantane = (home: number, away: number) =>
    JSON.stringify({ current: { home, away }, serving: "home", servingBox: "right" });

  it("accepte un jeu à l'avantage, qui n'a pas de plafond dans le règlement", () => {
    // 15-13 est un vrai score de squash : la borne ne doit pas mordre sur le jeu réel.
    expect(parseLive(instantane(15, 13))?.current).toEqual({ home: 15, away: 13 });
  });

  it("refuse un score que rien ne peut produire, plutôt que de le ramener dans les bornes", () => {
    // Le modèle n'a qu'un seul rôle : n'importe quel membre connecté peut poster ceci sur un
    // simple que personne ne tient. C'était stocké, mis en cache, puis servi à tous.
    expect(parseLive(instantane(1e15, 0))).toBeNull();
    expect(parseLive(instantane(0, 100))).toBeNull();
    // Ramener à 99 aurait INVENTÉ un score — ce que l'en-tête de ce lecteur promet de ne
    // jamais faire. On refuse, et l'affichage retombe sur les jeux terminés.
  });
});

describe("staleGamesReason — la règle unique des deux routes d'écriture", () => {
  const base = (...paires: [number, number][]) =>
    paires.map(([h, a]) => ({ pointsHome: h, pointsAway: a }));
  const envoi = (...paires: [number, number][]) => paires.map(([home, away]) => ({ home, away }));

  describe("sans compte annoncé — le champ reste facultatif, sauf pour retirer", () => {
    it("laisse CROÎTRE : c'est le chemin du marqueur point par point, il ne détruit rien", () => {
      expect(staleGamesReason(undefined, base([11, 5]), envoi([11, 5], [11, 8]))).toBeNull();
    });

    it("laisse une écriture de même longueur", () => {
      expect(staleGamesReason(undefined, base([11, 5]), envoi([11, 5]))).toBeNull();
    });

    it("REFUSE de retirer : rien ne distingue sinon « je n'ai rien à dire » de « efface tout »", () => {
      // Le corps minimal `{ games: [] }`, que tout membre proche du match peut poster.
      expect(staleGamesReason(undefined, base([11, 5], [11, 8]), envoi())).toMatch(/quel score/i);
    });
  });

  describe("avec un compte annoncé", () => {
    it("accepte quand le compte correspond et que les scores concordent", () => {
      expect(staleGamesReason(2, base([11, 5], [11, 8]), envoi([11, 5], [11, 8]))).toBeNull();
    });

    it("refuse un autre nombre de jeux — quelqu'un a écrit entre-temps", () => {
      expect(staleGamesReason(2, base([11, 5], [11, 8], [11, 3]), envoi([11, 5], [11, 8])))
        .toMatch(/changé ailleurs/i);
    });

    it("refuse le MÊME nombre sous un autre score — le trou des comparaisons de longueur", () => {
      // Le capitaine a corrigé le premier jeu ; le journal du marqueur porte l'ancienne version.
      expect(staleGamesReason(2, base([11, 9], [11, 8]), envoi([11, 2], [11, 8])))
        .toMatch(/changé ailleurs/i);
    });

    it("laisse passer un UNDO, qui raccourcit l'envoi sans toucher à l'état connu", () => {
      // La comparaison porte sur le PRÉFIXE COMMUN : exiger les jeux manquants interdirait
      // précisément l'undo que la règle du nombre prend soin d'autoriser.
      expect(staleGamesReason(2, base([11, 5], [11, 8]), envoi([11, 5]))).toBeNull();
    });

    it("refuse un undo dont le jeu conservé a changé, lui", () => {
      expect(staleGamesReason(2, base([11, 9], [11, 8]), envoi([11, 2]))).toMatch(/changé ailleurs/i);
    });
  });
});

describe("tieOutcome — le barème de la ligue, maintenant qu'un 2-2 est possible", () => {
  /** Un match gagné 3-0, avec son détail jeu par jeu. */
  const gagne = (pts: [number, number][] = [[11, 5], [11, 6], [11, 7]]) => ({
    gamesHome: pts.filter(([a, b]) => a > b).length,
    gamesAway: pts.filter(([a, b]) => b > a).length,
    status: "done",
    games: pts.map(([home, away]) => ({ home, away })),
  });
  const perdu = (pts: [number, number][] = [[5, 11], [6, 11], [7, 11]]) => gagne(pts);

  it("ne rend RIEN tant que la rencontre n'est pas finie", () => {
    // Un 2-1 en cours annoncé « Victoire, 3 pts » serait faux le temps d'un match, et c'est
    // exactement le moment où tout le monde regarde l'écran.
    expect(tieOutcome(4, [gagne(), gagne(), { gamesHome: null, gamesAway: null, status: "pending" },
      { gamesHome: null, gamesAway: null, status: "pending" }])).toBeNull();
  });

  it("victoire : 3 points, tranchée aux matchs", () => {
    const o = tieOutcome(4, [gagne(), gagne(), gagne(), perdu()]);
    expect(o).toMatchObject({ result: "win", leaguePoints: 3, decidedBy: "matches" });
    expect(o?.matches).toEqual({ home: 3, away: 1 });
  });

  it("défaite : 0 point", () => {
    expect(tieOutcome(4, [gagne(), perdu(), perdu(), perdu()])).toMatchObject({
      result: "loss",
      leaguePoints: 0,
      decidedBy: "matches",
    });
  });

  it("2-2 : l'average de JEUX départage, et rapporte 2 points au gagnant", () => {
    // Deux 3-0 gagnés, un 0-3 perdu, un 1-3 perdu : 7 jeux contre 6. Le match où l'on arrache
    // un jeu est exactement ce qui fait basculer le nul de notre côté.
    const o = tieOutcome(4, [
      gagne(),
      gagne(),
      perdu([[5, 11], [6, 11], [7, 11]]),
      perdu([[11, 5], [5, 11], [6, 11], [7, 11]]),
    ]);
    expect(o).toMatchObject({ result: "drawWon", leaguePoints: 2, decidedBy: "games" });
    expect(o?.matches).toEqual({ home: 2, away: 2 });
    expect(o?.games).toEqual({ home: 7, away: 6 });
  });

  it("2-2 : le perdant à l'average de jeux marque quand même 1 point", () => {
    const o = tieOutcome(4, [
      gagne(),
      gagne([[11, 5], [5, 11], [11, 6], [11, 7]]),
      perdu(),
      perdu(),
    ]);
    expect(o).toMatchObject({ result: "drawLost", leaguePoints: 1, decidedBy: "games" });
    expect(o?.games).toEqual({ home: 6, away: 7 });
  });

  it("LES JEUX AVANT LES POINTS — le cas qui distingue les deux règles", () => {
    // Reproduit CLOUD1–PUC1 du critérium 2025-26 : les jeux donnaient l'un, les points
    // l'autre, et c'est le gagnant AUX JEUX qui a reçu les deux points au classement. Prendre
    // les points d'abord désignerait ici le mauvais vainqueur.
    const o = tieOutcome(4, [
      // Deux victoires arrachées : beaucoup de jeux, peu d'écart au score.
      gagne([[11, 9], [11, 9], [11, 9]]),
      gagne([[11, 9], [11, 9], [11, 9]]),
      // Une déroute sèche, puis un match perdu 1-3 en ayant beaucoup encaissé : les POINTS
      // basculent chez l'adversaire (129 contre 83) alors que les JEUX restent chez nous.
      perdu([[1, 11], [1, 11], [1, 11]]),
      perdu([[11, 9], [1, 11], [1, 11], [1, 11]]),
    ]);
    expect(o?.games).toEqual({ home: 7, away: 6 });
    expect(o?.rallies?.home).toBeLessThan(o?.rallies?.away as number);
    expect(o).toMatchObject({ result: "drawWon", leaguePoints: 2, decidedBy: "games" });
  });

  it("à jeux ÉGAUX, ce sont les points qui départagent", () => {
    // Deux victoires écrasantes, deux défaites arrachées : 6 jeux partout, mais 120 points
    // contre 72. C'est le seul cas où l'average de points sert.
    const o = tieOutcome(4, [
      gagne([[11, 1], [11, 1], [11, 1]]),
      gagne([[11, 1], [11, 1], [11, 1]]),
      perdu([[9, 11], [9, 11], [9, 11]]),
      perdu([[9, 11], [9, 11], [9, 11]]),
    ]);
    expect(o?.games).toEqual({ home: 6, away: 6 });
    expect(o).toMatchObject({ result: "drawWon", leaguePoints: 2, decidedBy: "rallies" });
  });

  it("jeux ET points égaux : on ne tranche pas à la place de la ligue", () => {
    const o = tieOutcome(2, [gagne([[11, 5], [11, 6], [11, 7]]), perdu([[5, 11], [6, 11], [7, 11]])]);
    expect(o).toMatchObject({ result: "drawUnbroken", leaguePoints: null, decidedBy: null });
  });

  it("DÉTAIL INCOMPLET : les points sont tus, pas approximés", () => {
    // Un match saisi « 3-1 » sans son jeu par jeu rendrait un total PARTIEL, qu'on lirait
    // comme un total. Sur le chiffre qui départage, ça désignerait le mauvais vainqueur.
    const o = tieOutcome(4, [
      gagne(),
      gagne(),
      perdu(),
      { gamesHome: 1, gamesAway: 3, status: "done", games: [{ home: 11, away: 9 }] },
    ]);
    expect(o?.rallies).toBeNull();
    expect(o?.games).toEqual({ home: 7, away: 6 });
    expect(o).toMatchObject({ result: "drawWon", decidedBy: "games" });
  });

  it("sans aucun jeu par jeu, un nul à jeux égaux reste indépartageable", () => {
    const sansDetail = (h: number, a: number) => ({ gamesHome: h, gamesAway: a, status: "done" });
    expect(tieOutcome(4, [sansDetail(3, 1), sansDetail(3, 1), sansDetail(1, 3), sansDetail(1, 3)])).toMatchObject({
      result: "drawUnbroken",
      leaguePoints: null,
    });
  });
});
