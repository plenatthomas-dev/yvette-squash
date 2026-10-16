import { describe, it, expect } from "vitest";
import type { CheckReport } from "@/lib/captain-check";
import {
  enClair,
  rencontreFileName,
  rencontreTexte,
  verdictRencontre,
  type RencontrePartagee,
} from "@/lib/captain-image";

// La feuille partagée en image : le dessin lui-même se regarde (banc d'essai dans Chrome), ce
// fichier verrouille ce qui s'y ÉCRIT — noms, verdict, repli texte, nom de fichier.

const joueur = (order: number, side: "home" | "away", name: string, fedName: string | null) => ({
  order,
  side,
  name,
  verdict: fedName ? ("found" as const) : ("unknown" as const),
  fedName,
  clt: null,
  rangM: null,
  licence: null,
  club: null,
  hint: null,
});

const rapport = (tie: Partial<CheckReport["tie"]> = {}): CheckReport => ({
  checkedAt: "2026-10-16T17:00:00.000Z",
  players: [
    joueur(1, "home", "Thomas", "PLENAT THOMAS"),
    joueur(1, "away", "Guillaume", "THUILLIER GUILLAUME"),
    joueur(2, "home", "Jean", "DUPONT JEAN-PIERRE"),
    joueur(2, "away", "Martin", null),
  ],
  scores: [
    {
      order: 1,
      ok: true,
      problem: null,
      gamesHome: 3,
      gamesAway: 1,
      winner: "home",
      games: [
        { home: 9, away: 11 },
        { home: 11, away: 7 },
        { home: 11, away: 5 },
        { home: 11, away: 8 },
      ],
    },
    { order: 2, ok: true, problem: null, gamesHome: 0, gamesAway: 3, winner: "away", games: [] },
  ],
  tie: { ok: true, home: 1, away: 1, undecided: 0, problem: null, ...tie },
  awayOrder: { status: "ok", problem: null },
});

const rencontre = (r = rapport()): RencontrePartagee => ({
  nous: "Yvette 1",
  eux: "Verrières 3",
  home: true,
  date: "2026-10-15",
  round: "J3",
  rapport: r,
});

describe("enClair — le nom fédéral, lisible dans une conversation", () => {
  it("capitales → initiales, y compris après un trait d'union ou une apostrophe", () => {
    expect(enClair("DUPONT JEAN-PIERRE")).toBe("Dupont Jean-Pierre");
    expect(enClair("D'ARTAGNAN CHARLES")).toBe("D'Artagnan Charles");
    expect(enClair("ÉLODIE LEBŒUF")).toBe("Élodie Lebœuf");
  });
});

describe("verdictRencontre", () => {
  it("nomme le vainqueur, qu'il s'agisse de nous ou d'eux", () => {
    expect(verdictRencontre(rencontre(rapport({ home: 3, away: 1 })))).toBe("🏆 Yvette 1 gagne 3-1");
    expect(verdictRencontre(rencontre(rapport({ home: 1, away: 3 })))).toBe("🏆 Verrières 3 gagne 3-1");
  });

  // En division 4, quatre simples : le 2-2 existe.
  it("dit le nul, et une rencontre inachevée comme telle", () => {
    expect(verdictRencontre(rencontre(rapport({ home: 2, away: 2 })))).toBe("Match nul 2-2");
    expect(verdictRencontre(rencontre(rapport({ home: 2, away: 1, undecided: 1 })))).toBe(
      "Rencontre en cours : 2-1",
    );
  });
});

describe("rencontreTexte — le repli sans canvas", () => {
  it("le compte, puis un simple par ligne, nom fédéral quand on l'a, nom saisi sinon", () => {
    expect(rencontreTexte(rencontre())).toBe(
      [
        "Yvette 1 1-1 Verrières 3",
        "1. Plenat Thomas – Thuillier Guillaume : 9-11 11-7 11-5 11-8",
        // Pas de détail jeu par jeu (simple saisi en jeux seulement) : les jeux gagnés.
        "2. Dupont Jean-Pierre – Martin : 0-3",
      ].join("\n"),
    );
  });
});

describe("rencontreFileName", () => {
  it("lisible, sans accents, daté", () => {
    expect(rencontreFileName(rencontre())).toBe("rencontre-yvette-1-verrieres-3-2026-10-15.png");
  });
});
