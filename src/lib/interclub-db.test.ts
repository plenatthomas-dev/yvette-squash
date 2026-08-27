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
