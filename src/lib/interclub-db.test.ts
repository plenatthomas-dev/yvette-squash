import { describe, it, expect } from "vitest";
import {
  derivedStatus,
  fixtureScore,
  gamesWonFrom,
  parseLive,
  scorerIsStale,
  SCORER_STALE_MS,
} from "./interclub-db";

describe("fixtureScore", () => {
  it("compte les matchs gagnés de chaque côté", () => {
    expect(
      fixtureScore([
        { gamesHome: 3, gamesAway: 0 },
        { gamesHome: 1, gamesAway: 3 },
        { gamesHome: 3, gamesAway: 2 },
      ]),
    ).toEqual({ home: 2, away: 1 });
  });

  it("ignore les matchs sans résultat : une rencontre en cours affiche 1-0, pas 1-3", () => {
    expect(
      fixtureScore([
        { gamesHome: 3, gamesAway: 0 },
        { gamesHome: null, gamesAway: null },
        { gamesHome: null, gamesAway: null },
      ]),
    ).toEqual({ home: 1, away: 0 });
  });
});

describe("gamesWonFrom", () => {
  it("déduit les jeux gagnés des jeux terminés", () => {
    expect(
      gamesWonFrom([
        { pointsHome: 11, pointsAway: 5 },
        { pointsHome: 9, pointsAway: 11 },
        { pointsHome: 12, pointsAway: 10 },
      ]),
    ).toEqual({ home: 2, away: 1 });
  });

  it("ne compte pas un jeu non terminé", () => {
    expect(gamesWonFrom([{ pointsHome: 7, pointsAway: 4 }])).toEqual({ home: 0, away: 0 });
  });
});

describe("derivedStatus", () => {
  const pending = { gamesHome: null, status: "pending" };
  const done = { gamesHome: 3, status: "done" };

  it("programmée tant qu'aucun match n'a commencé", () => {
    expect(derivedStatus(4, [pending, pending, pending, pending])).toBe("scheduled");
  });

  it("en cours dès qu'un match a un résultat", () => {
    expect(derivedStatus(4, [done, pending, pending, pending])).toBe("live");
  });

  it("en cours dès qu'un match est marqué en direct, même sans résultat", () => {
    expect(derivedStatus(4, [{ gamesHome: null, status: "live" }, pending, pending, pending])).toBe("live");
  });

  it("terminée quand tous les matchs ont un résultat", () => {
    expect(derivedStatus(4, [done, done, done, done])).toBe("done");
  });

  it("ne se déclare pas terminée si des matchs manquent encore à l'appel", () => {
    expect(derivedStatus(4, [done, done])).toBe("live");
  });
});

describe("matchs simultanés", () => {
  // Cas réel : 4 matchs sur 2 terrains, donc deux marqueurs en parallèle sur deux
  // téléphones. Rien dans le modèle ne suppose un match en cours à la fois — ces tests
  // le figent, parce que c'est une garantie facile à casser par inadvertance.

  it("deux matchs en cours en même temps laissent la rencontre « en cours »", () => {
    expect(
      derivedStatus(4, [
        { gamesHome: null, status: "live" },
        { gamesHome: null, status: "live" },
        { gamesHome: null, status: "pending" },
        { gamesHome: null, status: "pending" },
      ]),
    ).toBe("live");
  });

  it("le score de la rencontre ne compte que les matchs finis, les autres tournant encore", () => {
    expect(
      fixtureScore([
        { gamesHome: 3, gamesAway: 1 },
        { gamesHome: 0, gamesAway: 3 },
        { gamesHome: null, gamesAway: null }, // en cours sur le terrain 1
        { gamesHome: null, gamesAway: null }, // en cours sur le terrain 2
      ]),
    ).toEqual({ home: 1, away: 1 });
  });

  it("deux instantanés de direct coexistent sans se mélanger", () => {
    const a = parseLive(JSON.stringify({ current: { home: 7, away: 4 }, serving: "home" }));
    const b = parseLive(JSON.stringify({ current: { home: 2, away: 9 }, serving: "away" }));
    expect(a?.current).toEqual({ home: 7, away: 4 });
    expect(b?.current).toEqual({ home: 2, away: 9 });
  });

  it("deux prises de marquage distinctes s'évaluent indépendamment", () => {
    const now = new Date("2026-09-03T21:00:00Z");
    const frais = new Date(now.getTime() - 10_000);
    const abandonne = new Date(now.getTime() - SCORER_STALE_MS - 1000);
    expect(scorerIsStale(frais, frais, now)).toBe(false);
    expect(scorerIsStale(abandonne, abandonne, now)).toBe(true);
  });
});

describe("scorerIsStale", () => {
  const now = new Date("2026-09-03T21:00:00Z");

  it("une prise sans horodatage est périmée", () => {
    expect(scorerIsStale(null, new Date(0), now)).toBe(true);
  });

  it("une prise récente tient", () => {
    const recent = new Date(now.getTime() - 60_000);
    expect(scorerIsStale(recent, recent, now)).toBe(false);
  });

  it("une prise abandonnée se libère, sinon un téléphone à plat gèlerait le match", () => {
    const vieux = new Date(now.getTime() - SCORER_STALE_MS - 1000);
    expect(scorerIsStale(vieux, vieux, now)).toBe(true);
  });

  it("une écriture récente rafraîchit la prise même si elle a été prise il y a longtemps", () => {
    const vieux = new Date(now.getTime() - SCORER_STALE_MS - 1000);
    const frais = new Date(now.getTime() - 5_000);
    expect(scorerIsStale(vieux, frais, now)).toBe(false);
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
