import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// LE CLASSEMENT DE LA POULE, À L'ÉCRAN.
//
// Deux propriétés tiennent tout ce bloc, et aucune ne se voit à la relecture :
//
//  1. NOTRE LIGNE EST RECONNUE PAR L'IDENTIFIANT FÉDÉRAL, jamais par le nom. La ligue écrit
//     « Squash de l'Yvette » là où nous écrivons « Équipe 2 » : un rapprochement par nom ne
//     surlignerait jamais rien, ou surlignerait la mauvaise ligne le jour où deux équipes du
//     club jouent la même poule.
//  2. LA DATE DU RELEVÉ EST AFFICHÉE. Sans elle, un classement figé depuis trois semaines
//     s'affiche exactement comme un classement à jour.

const ligne = (over: Record<string, unknown>) => ({
  rank: 1,
  name: "Liberty Country Club 3",
  code: "THIVE 3",
  snTeamId: "161115",
  points: 12,
  played: 5,
  won: 4,
  drawWon: 0,
  drawLost: 0,
  lost: 1,
  penalties: 0,
  matches: { won: 18, lost: 6, diff: 12 },
  games: { won: 62, lost: 28, diff: 34 },
  rallies: { won: 896, lost: 605, diff: 291 },
  ...over,
});

/** Le classement réel de la poule IVD, réduit à trois lignes. */
const CLASSEMENT = [
  ligne({}),
  ligne({
    rank: 2,
    name: "Squash de l'Yvette",
    code: "YVETTE",
    snTeamId: "161092",
    points: 9,
    played: 4,
    won: 3,
    drawWon: 1,
    drawLost: 2,
    lost: 1,
    matches: { won: 11, lost: 4, diff: 7 },
    games: { won: 39, lost: 19, diff: 20 },
    rallies: { won: 559, lost: 436, diff: 123 },
  }),
  ligne({ rank: 3, name: "Chaville 4", code: "CHVL4", snTeamId: "161087", points: 6 }),
];

const equipe = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Équipe 2",
  captainId: null,
  captainName: null,
  snTeamId: "161092",
  standings: CLASSEMENT,
  standingsAt: "2026-09-04T09:00:00.000Z",
  ...over,
});

function servir(teams: Record<string, unknown>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Le bandeau « en direct » interroge la même racine : lui servir la charge de la liste
    // le ferait planter sur des rencontres sans simples.
    const liste = /\/api\/interclub(\?|$)/.test(url);
    const corps = liste
      ? { teams, fixtures: [], follows: [], pushReady: false, hasMore: false }
      : { fixtures: [], follows: [], pushReady: false };
    return new Response(JSON.stringify(corps), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const monter = () => render(<Interclub toast={() => {}} onExpired={() => false} />);

beforeEach(() => {
  vi.stubGlobal("fetch", servir([equipe()]));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("le classement de la poule", () => {
  it("annonce notre rang et la date du relevé sans qu'on ait à déplier", async () => {
    monter();
    await waitFor(() => expect(screen.getByText("Classement")).toBeTruthy());
    // Le rang répond à la question courante ; ouvrir devient un choix, pas un passage obligé.
    // Il est en PASTILLE, séparé du « sur 3 » : c'est ce qu'on vient chercher.
    expect(screen.getByText("2e")).toBeTruthy();
    expect(screen.getByText(/sur 3/)).toBeTruthy();
    expect(screen.getByText(/4 sept\./)).toBeTruthy();
  });

  it("SURLIGNE notre ligne par l'identifiant fédéral, pas par le nom", async () => {
    monter();
    const nous = await screen.findByText("Squash de l'Yvette");
    expect(nous.closest("tr")?.className).toContain("is-us");
    expect(screen.getByText("Chaville 4").closest("tr")?.className).not.toContain("is-us");
  });

  it("ne surligne RIEN quand l'ancrage manque, plutôt qu'une ligne au hasard", async () => {
    vi.stubGlobal("fetch", servir([equipe({ snTeamId: null })]));
    monter();
    await screen.findByText("Squash de l'Yvette");
    expect(document.querySelectorAll("tr.is-us")).toHaveLength(0);
    // Et le résumé cesse d'annoncer un rang qu'il ne peut pas connaître.
    expect(screen.getByText(/3 équipes/)).toBeTruthy();
  });

  it("donne nos stats en toutes lettres — les averages départagent", async () => {
    monter();
    await screen.findByText("Classement");
    const avg = screen.getByText(/Nos stats/);
    expect(avg.textContent).toContain("jeux 39–19 (+20)");
    expect(avg.textContent).toContain("points 559–436 (+123)");
    expect(avg.textContent).toContain("matchs 11–4 (+7)");
  });

  it("montre les colonnes E+ et E-, celles du nul", async () => {
    monter();
    await screen.findByText("Classement");
    expect(screen.getByText("E+")).toBeTruthy();
    expect(screen.getByText("E-")).toBeTruthy();
  });

  it("n'affiche RIEN quand la poule n'a pas de classement publié", async () => {
    vi.stubGlobal("fetch", servir([equipe({ standings: null, standingsAt: null })]));
    monter();
    await waitFor(() => expect(screen.getByText(/Aucune rencontre/)).toBeTruthy());
    expect(screen.queryByText("Classement")).toBeNull();
  });
});
