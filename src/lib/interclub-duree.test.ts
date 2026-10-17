import { describe, it, expect } from "vitest";
import {
  correctedGameTimes,
  fixtureDurationMs,
  formatDuration,
  liveGameTimes,
  liveMatchTimes,
  matchDurationMs,
  MAX_MATCH_MS,
} from "./interclub-duree";

const MIN = 60_000;
const T0 = new Date("2026-10-15T18:30:00Z");
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const iso = (min: number) => at(min).toISOString();

const vierge = { status: "pending", startedAt: null, finishedAt: null };

describe("liveMatchTimes — le début", () => {
  it("se pose au premier point", () => {
    expect(liveMatchTimes(vierge, { status: "live", games: 0 }, at(0))).toEqual({
      startedAt: at(0),
      finishedAt: null,
    });
  });

  it("ne bouge plus ensuite", () => {
    const enCours = { status: "live", startedAt: at(0), finishedAt: null };
    expect(liveMatchTimes(enCours, { status: "live", games: 2 }, at(25)).startedAt).toEqual(at(0));
  });

  it("s'efface si le premier point est annulé — le suivant le reposera", () => {
    const enCours = { status: "live", startedAt: at(0), finishedAt: null };
    expect(liveMatchTimes(enCours, { status: "pending", games: 0 }, at(1))).toEqual({
      startedAt: null,
      finishedAt: null,
    });
  });

  it("reste inconnu si la première écriture porte déjà un jeu : le téléphone comptait hors ligne", () => {
    expect(liveMatchTimes(vierge, { status: "live", games: 1 }, at(12)).startedAt).toBeNull();
  });

  it("…et ne vaut pas zéro pour un match synchronisé d'un bloc, une fois fini", () => {
    expect(liveMatchTimes(vierge, { status: "done", games: 3 }, at(40))).toEqual({
      startedAt: null,
      finishedAt: at(40),
    });
  });

  it("reste inconnu pour un match déjà en cours sans début (saisi après coup, ou d'avant la mesure)", () => {
    const sansDebut = { status: "live", startedAt: null, finishedAt: null };
    expect(liveMatchTimes(sansDebut, { status: "live", games: 2 }, at(30)).startedAt).toBeNull();
  });

  it("se repose sur un match vidé puis rejoué : l'ancien début ne vaut plus", () => {
    // La correction a posteriori (`PATCH`) a vidé les jeux sans toucher aux heures.
    const vide = { status: "pending", startedAt: at(0), finishedAt: at(40) };
    expect(liveMatchTimes(vide, { status: "live", games: 0 }, at(90))).toEqual({
      startedAt: at(90),
      finishedAt: null,
    });
  });
});

describe("liveMatchTimes — la fin", () => {
  const enCours = { status: "live", startedAt: at(0), finishedAt: null };

  it("se pose au point décisif", () => {
    expect(liveMatchTimes(enCours, { status: "done", games: 3 }, at(42)).finishedAt).toEqual(at(42));
  });

  it("ne bouge pas quand le marqueur renvoie le même état (reprise après coupure)", () => {
    const fini = { status: "done", startedAt: at(0), finishedAt: at(42) };
    expect(liveMatchTimes(fini, { status: "done", games: 3 }, at(50)).finishedAt).toEqual(at(42));
  });

  it("s'efface si le point décisif est annulé", () => {
    const fini = { status: "done", startedAt: at(0), finishedAt: at(42) };
    expect(liveMatchTimes(fini, { status: "live", games: 2 }, at(43))).toEqual({
      startedAt: at(0),
      finishedAt: null,
    });
  });

  it("n'en invente pas pour un match terminé avant la mesure", () => {
    const ancien = { status: "done", startedAt: null, finishedAt: null };
    expect(liveMatchTimes(ancien, { status: "done", games: 3 }, at(5)).finishedAt).toBeNull();
  });
});

describe("heures des jeux", () => {
  const g = (home: number, away: number) => ({ home, away });
  const stored = (home: number, away: number, finishedAt: Date | null) => ({
    pointsHome: home,
    pointsAway: away,
    finishedAt,
  });

  it("en direct : un jeu inchangé garde son heure, seul le nouveau prend l'heure courante", () => {
    const prev = [stored(11, 5, at(10))];
    expect(liveGameTimes(prev, [g(11, 5), g(9, 11)], at(22))).toEqual([at(10), at(22)]);
  });

  it("en direct : un jeu dont le score a changé reprend l'heure courante", () => {
    const prev = [stored(11, 5, at(10)), stored(11, 9, at(20))];
    expect(liveGameTimes(prev, [g(11, 5), g(12, 10)], at(23))).toEqual([at(10), at(23)]);
  });

  it("en direct : plusieurs jeux nouveaux d'un coup n'ont pas d'heure connue", () => {
    expect(liveGameTimes([], [g(11, 5), g(11, 7)], at(25))).toEqual([null, null]);
  });

  it("après coup : un jeu corrigé garde son heure, un jeu ajouté n'en a pas", () => {
    const prev = [stored(11, 5, at(10))];
    expect(correctedGameTimes(prev, [g(11, 7), g(11, 3)])).toEqual([at(10), null]);
  });
});

describe("matchDurationMs", () => {
  it("terminé : du premier au dernier point", () => {
    expect(matchDurationMs({ status: "done", startedAt: iso(0), finishedAt: iso(42) }, 0)).toBe(42 * MIN);
  });

  it("en cours : depuis le premier point", () => {
    const m = { status: "live", startedAt: iso(0), finishedAt: null };
    expect(matchDurationMs(m, at(18).getTime())).toBe(18 * MIN);
  });

  it("rien sans début connu", () => {
    expect(matchDurationMs({ status: "done", startedAt: null, finishedAt: iso(42) }, 0)).toBeNull();
  });

  it("rien pour un match terminé sans heure de fin (fini par une saisie après coup)", () => {
    expect(matchDurationMs({ status: "done", startedAt: iso(0), finishedAt: null }, 0)).toBeNull();
  });

  it("rien pour un match à saisir, même s'il garde des heures d'avant une correction", () => {
    expect(matchDurationMs({ status: "pending", startedAt: iso(0), finishedAt: iso(42) }, 0)).toBeNull();
  });

  it("rien au-delà de trois heures : c'est un oubli, pas un match", () => {
    const oublie = { status: "live", startedAt: iso(0), finishedAt: null };
    expect(matchDurationMs(oublie, T0.getTime() + MAX_MATCH_MS + MIN)).toBeNull();
  });

  it("jamais négatif quand l'horloge du téléphone retarde sur le serveur", () => {
    const m = { status: "live", startedAt: iso(0), finishedAt: null };
    expect(matchDurationMs(m, at(-1).getTime())).toBe(0);
  });
});

describe("fixtureDurationMs", () => {
  const fini = (start: number, end: number) => ({ status: "done", startedAt: iso(start), finishedAt: iso(end) });

  it("du premier point du premier simple au point décisif du dernier", () => {
    // Deux courts : les simples se chevauchent, la soirée va du plus tôt au plus tard.
    expect(fixtureDurationMs([fini(0, 40), fini(5, 50), fini(45, 95), fini(55, 130)])).toBe(130 * MIN);
  });

  it("rien tant qu'un simple n'est pas terminé", () => {
    expect(
      fixtureDurationMs([fini(0, 40), { status: "live", startedAt: iso(45), finishedAt: null }]),
    ).toBeNull();
  });

  it("rien si un seul simple a été saisi après coup", () => {
    expect(fixtureDurationMs([fini(0, 40), { status: "done", startedAt: null, finishedAt: null }])).toBeNull();
  });

  it("rien pour une rencontre sans simple", () => {
    expect(fixtureDurationMs([])).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "1 min"],
    [29_000, "1 min"],
    [42 * MIN, "42 min"],
    [59 * MIN + 20_000, "59 min"],
    [59 * MIN + 40_000, "1 h 00"],
    [65 * MIN, "1 h 05"],
    [155 * MIN, "2 h 35"],
  ])("%i ms → %s", (ms, attendu) => {
    expect(formatDuration(ms)).toBe(attendu);
  });
});
