import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import InterclubTally from "@/components/InterclubTally";
import type { TallyMatch } from "@/lib/interclub";

// CE QUE LA LIGNE D'AVANCE DIT — et surtout ce qu'elle refuse de laisser croire.
//
// Un average affiché en permanence se lit comme un enjeu permanent. Or il ne départage QUE sur
// un nul : ces essais tiennent la ligne responsable de le dire quand ce n'est pas le cas.

const fini = (games: [number, number][]): TallyMatch => ({
  status: "done",
  gamesHome: games.filter(([h, a]) => h > a).length,
  gamesAway: games.filter(([h, a]) => a > h).length,
  games: games.map(([home, away]) => ({ home, away })),
  live: null,
});
const enCours = (games: [number, number][], current: [number, number]): TallyMatch => ({
  status: "live",
  gamesHome: games.length ? games.filter(([h, a]) => h > a).length : null,
  gamesAway: games.length ? games.filter(([h, a]) => a > h).length : null,
  games: games.map(([home, away]) => ({ home, away })),
  live: { current: { home: current[0], away: current[1] } },
});
const vide = (): TallyMatch => ({ status: "pending", gamesHome: null, gamesAway: null, games: [], live: null });

const GAGNE = [
  [11, 5],
  [11, 7],
  [11, 9],
] as [number, number][];
const PERDU = [
  [5, 11],
  [7, 11],
  [9, 11],
] as [number, number][];

describe("la ligne d'avance pendant la rencontre", () => {
  it("ne s'affiche pas tant que rien n'est joué", () => {
    const { container } = render(<InterclubTally matchCount={4} matches={[vide(), vide(), vide(), vide()]} />);
    expect(container.querySelector(".ic-tally")).toBeNull();
  });

  it("montre les jeux, les points et ce qu'un nul rapporterait", () => {
    render(
      <InterclubTally
        matchCount={4}
        matches={[fini(GAGNE), fini(PERDU), enCours([[11, 9]], [4, 2]), vide()]}
      />,
    );
    expect(screen.getByText(/jeux 4–3/)).toBeTruthy();
    // 33–21 et 21–33 pour les deux finis, 15–11 pour celui en cours (jeu en cours compris).
    expect(screen.getByText(/points 69–65/)).toBeTruthy();
    expect(screen.getByText(/Un 2–2 nous donnerait le nul gagné \(E\+, 2 pts\) : 1 jeu d'avance\./)).toBeTruthy();
  });

  it("dit le retard plutôt que de le taire", () => {
    render(
      <InterclubTally
        matchCount={4}
        matches={[fini(GAGNE), fini(PERDU), enCours([[9, 11], [7, 11]], [0, 0]), vide()]}
      />,
    );
    expect(screen.getByText(/Un 2–2 nous laisserait le nul perdu \(E-, 1 pt\) : 2 jeux de retard\./)).toBeTruthy();
  });

  it("bascule sur les points quand les jeux sont à égalité", () => {
    render(<InterclubTally matchCount={4} matches={[fini(GAGNE), fini(PERDU), vide(), vide()]} />);
    // 33–21 et 21–33 : jeux 3–3, points 54–54… donc rien ne départage.
    expect(screen.getByText(/Un 2–2 que rien ne départagerait pour l'instant\./)).toBeTruthy();
  });

  it("dit que l'average ne décidera rien quand le nul n'est plus atteignable", () => {
    // Trois simples, 1-1, un seul restant : quelqu'un gagnera ce match.
    render(<InterclubTally matchCount={3} matches={[fini(GAGNE), fini(PERDU), vide()]} />);
    expect(screen.getByText(/Le nul n'est plus atteignable/)).toBeTruthy();
  });

  it("dit la victoire acquise plutôt qu'un average sans objet", () => {
    render(
      <InterclubTally
        matchCount={4}
        matches={[fini(GAGNE), fini(GAGNE), fini(GAGNE), enCours([], [3, 1])]}
      />,
    );
    expect(screen.getByText(/Victoire acquise aux matchs — 3 pts au classement\./)).toBeTruthy();
  });

  it("ne présente pas un total de points partiel comme un total", () => {
    render(
      <InterclubTally
        matchCount={4}
        matches={[
          { status: "done", gamesHome: 3, gamesAway: 1, games: [], live: null },
          fini(PERDU),
          vide(),
          vide(),
        ]}
      />,
    );
    expect(screen.getByText("points indisponibles")).toBeTruthy();
    expect(screen.queryByText(/points \d+–\d+/)).toBeNull();
  });
});
