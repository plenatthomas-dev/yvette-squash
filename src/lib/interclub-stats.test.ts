import { describe, it, expect } from "vitest";
import { playerStats, type StatMatch } from "./interclub-stats";

/** Un simple joué, avec son jeu par jeu complet. */
const simple = (over: Partial<StatMatch> & { homeDisplayName: string }): StatMatch => {
  const gagne = (over.gamesHome ?? 3) > (over.gamesAway ?? 0);
  const nbJeux = (over.gamesHome ?? 3) + (over.gamesAway ?? 0);
  return {
    status: "done",
    gamesHome: 3,
    gamesAway: 0,
    homeUserId: null,
    homeGuestId: null,
    games: Array.from({ length: nbJeux }, () => ({ home: gagne ? 11 : 6, away: gagne ? 6 : 11 })),
    ...over,
  };
};

describe("playerStats", () => {
  it("compte les matchs, les victoires et la part de victoires", () => {
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Thomas", gamesHome: 3, gamesAway: 1 }),
      simple({ homeUserId: "u1", homeDisplayName: "Thomas", gamesHome: 3, gamesAway: 0 }),
      simple({ homeUserId: "u1", homeDisplayName: "Thomas", gamesHome: 1, gamesAway: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ played: 3, won: 2, lost: 1, isMember: true });
    expect(rows[0].winRate).toBeCloseTo(2 / 3);
    expect(rows[0].games).toEqual({ won: 7, lost: 4, diff: 3 });
  });

  it("NE COMPTE PAS un match en cours, même s'il mène", () => {
    // `gamesHome` est écrite dès le premier jeu joué. S'y fier ferait bouger le pourcentage
    // de victoires de toute l'équipe pendant qu'on joue.
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Thomas", status: "live", gamesHome: 1, gamesAway: 0 }),
      simple({ homeUserId: "u1", homeDisplayName: "Thomas", status: "pending", gamesHome: null, gamesAway: null }),
    ]);
    expect(rows).toEqual([]);
  });

  it("sépare les joueurs, membres et sans compte", () => {
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Thomas" }),
      simple({ homeGuestId: "g1", homeDisplayName: "Paul Hors-Appli" }),
    ]);
    // À palmarès identique, c'est le nom qui départage — d'où Paul avant Thomas.
    expect(rows.map((r) => [r.name, r.isMember])).toEqual([
      ["Paul Hors-Appli", false],
      ["Thomas", true],
    ]);
  });

  it("GARDE l'historique d'un joueur retiré du roster", () => {
    // `onDelete: SetNull` : la ligne survit, l'identifiant disparaît, le nom reste figé.
    // Jeter ces matchs ferait fondre le total de l'équipe sans que personne ne comprenne.
    const rows = playerStats([
      simple({ homeDisplayName: "Ancien Membre" }),
      simple({ homeDisplayName: "Ancien Membre", gamesHome: 0, gamesAway: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Ancien Membre", played: 2, won: 1, isMember: false });
  });

  it("ne fusionne PAS deux joueurs sur leur seul nom quand les identifiants diffèrent", () => {
    // Deux homonymes existent dans un club ; les additionner donnerait à l'un le palmarès
    // des deux.
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Martin" }),
      simple({ homeUserId: "u2", homeDisplayName: "Martin" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("cumule les points de jeu quand le détail est complet", () => {
    const rows = playerStats([
      {
        status: "done",
        gamesHome: 2,
        gamesAway: 1,
        homeUserId: "u1",
        homeGuestId: null,
        homeDisplayName: "Thomas",
        games: [
          { home: 11, away: 5 },
          { home: 8, away: 11 },
          { home: 11, away: 9 },
        ],
      },
    ]);
    expect(rows[0].rallies).toEqual({ won: 30, lost: 25, diff: 5 });
  });

  it("TAIT les points dès qu'un seul match manque de détail", () => {
    // Un total partiel présenté comme un total est pire que pas de total : il se compare aux
    // autres lignes, qui, elles, sont complètes.
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Thomas" }),
      {
        status: "done",
        gamesHome: 3,
        gamesAway: 1,
        homeUserId: "u1",
        homeGuestId: null,
        homeDisplayName: "Thomas",
        games: [{ home: 11, away: 5 }],
      },
    ]);
    expect(rows[0].played).toBe(2);
    expect(rows[0].rallies).toBeNull();
    // Les JEUX, eux, restent comptés : ils viennent de la ligne du match, pas du détail.
    expect(rows[0].games).toEqual({ won: 6, lost: 1, diff: 5 });
  });

  it("classe par VICTOIRES et non par pourcentage", () => {
    // Classer au pourcentage mettrait en tête celui qui a gagné son unique match, devant
    // celui qui en a gagné trois sur quatre. Personne ne reconnaîtrait ce palmarès.
    const rows = playerStats([
      simple({ homeUserId: "u1", homeDisplayName: "Un seul match" }),
      ...Array.from({ length: 3 }, () =>
        simple({ homeUserId: "u2", homeDisplayName: "Trois victoires" }),
      ),
      simple({ homeUserId: "u2", homeDisplayName: "Trois victoires", gamesHome: 0, gamesAway: 3 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Trois victoires", "Un seul match"]);
    expect(rows[0].winRate).toBeCloseTo(0.75);
    expect(rows[1].winRate).toBe(1);
  });

  it("rend une liste vide sans rien inventer", () => {
    expect(playerStats([])).toEqual([]);
  });
});
