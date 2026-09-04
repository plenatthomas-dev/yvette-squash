import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// CE QUE LA RENCONTRE RAPPORTE, ET PAS SEULEMENT SON SCORE.
//
// Depuis que la division 4 se joue en QUATRE simples, « 2-2 » est une issue courante — et deux
// rencontres affichées « 2-2 » peuvent valoir deux points de classement ou un seul selon
// l'average. L'écran doit donc dire le verdict et montrer le chiffre qui l'a tranché : sans
// ça, la carte affiche un score dont personne ne peut déduire ce qu'on a gagné.

const equipe = { id: "t1", name: "Équipe 2", captainId: null, captainName: null };

const carte = (over: Record<string, unknown>) => ({
  id: "f1",
  date: "2026-06-18",
  time: "20:00",
  venue: null,
  venueAddress: null,
  round: "J05",
  dateConfirmed: true,
  team: equipe,
  opponent: "Verrieres 3",
  home: true,
  division: "D4",
  matchCount: 4,
  status: "done",
  score: { home: 2, away: 2 },
  ...over,
});

function servir(fixtures: Record<string, unknown>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Le bandeau « en direct » interroge la MÊME racine : lui servir la charge de la liste
    // lui donnerait des rencontres sans simples, et il planterait sur `f.matches.map`.
    const liste = /\/api\/interclub(\?|$)/.test(url);
    const corps = liste
      ? { teams: [equipe], fixtures, follows: [], pushReady: false, hasMore: false }
      : { fixtures: [], follows: [], pushReady: false };
    return new Response(JSON.stringify(corps), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", servir([]));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const monter = () =>
  render(<Interclub toast={() => {}} onExpired={() => false} />);

describe("la ligne de résultat sur la carte d'une rencontre", () => {
  it("dit « Nul gagné », son sigle E+, ses 2 points et les deux averages", async () => {
    vi.stubGlobal(
      "fetch",
      servir([
        carte({
          outcome: {
            result: "drawWon",
            leaguePoints: 2,
            matches: { home: 2, away: 2 },
            games: { home: 9, away: 8 },
            rallies: { home: 153, away: 161 },
            decidedBy: "games",
          },
        }),
      ]),
    );
    monter();
    await waitFor(() => expect(screen.getByText("Nul gagné")).toBeTruthy());
    expect(screen.getByText("E+")).toBeTruthy();
    expect(screen.getByText("2 pts")).toBeTruthy();
    expect(screen.getByText(/jeux 9–8/)).toBeTruthy();
    expect(screen.getByText(/points 153–161/)).toBeTruthy();
  });

  it("MARQUE l'average qui a tranché, et lui seul", async () => {
    // C'est le repère qui empêche « Nul gagné » de passer pour une décision arbitraire de
    // l'appli : ici les jeux disent l'un et les points l'autre, et seuls les jeux comptent.
    vi.stubGlobal(
      "fetch",
      servir([
        carte({
          outcome: {
            result: "drawWon",
            leaguePoints: 2,
            matches: { home: 2, away: 2 },
            games: { home: 9, away: 8 },
            rallies: { home: 153, away: 161 },
            decidedBy: "games",
          },
        }),
      ]),
    );
    monter();
    const jeux = await screen.findByText(/jeux 9–8/);
    expect(jeux.className).toContain("is-decisive");
    expect(screen.getByText(/points 153–161/).className).not.toContain("is-decisive");
  });

  it("TAIT les points quand le jeu par jeu est incomplet", async () => {
    // Un total partiel présenté comme un total désignerait le mauvais vainqueur — mieux vaut
    // ne rien afficher que d'afficher un chiffre faux sur celui qui départage.
    vi.stubGlobal(
      "fetch",
      servir([
        carte({
          outcome: {
            result: "drawLost",
            leaguePoints: 1,
            matches: { home: 2, away: 2 },
            games: { home: 6, away: 7 },
            rallies: null,
            decidedBy: "games",
          },
        }),
      ]),
    );
    monter();
    await waitFor(() => expect(screen.getByText("Nul perdu")).toBeTruthy());
    expect(screen.getByText("E-")).toBeTruthy();
    expect(screen.getByText("1 pt")).toBeTruthy();
    expect(screen.queryByText(/points /)).toBeNull();
  });

  it("n'affiche RIEN sur une rencontre pas encore jouée", async () => {
    vi.stubGlobal(
      "fetch",
      servir([carte({ status: "scheduled", score: { home: 0, away: 0 }, outcome: null })]),
    );
    monter();
    await waitFor(() => expect(screen.getByText(/Verrieres 3/)).toBeTruthy());
    expect(screen.queryByText(/jeux /)).toBeNull();
    expect(screen.queryByText("Victoire")).toBeNull();
    expect(screen.queryByText("Nul gagné")).toBeNull();
  });

  it("une victoire ne porte NI sigle ni mention de départage", async () => {
    // Le sigle E+/E- appartient au classement fédéral et ne veut rien dire sur une victoire ;
    // l'y coller ferait passer trois points pour deux.
    vi.stubGlobal(
      "fetch",
      servir([
        carte({
          score: { home: 3, away: 1 },
          outcome: {
            result: "win",
            leaguePoints: 3,
            matches: { home: 3, away: 1 },
            games: { home: 10, away: 4 },
            rallies: { home: 158, away: 120 },
            decidedBy: "matches",
          },
        }),
      ]),
    );
    monter();
    await waitFor(() => expect(screen.getByText("Victoire")).toBeTruthy());
    expect(screen.getByText("3 pts")).toBeTruthy();
    expect(screen.queryByText("E+")).toBeNull();
    expect(screen.getByText(/jeux 10–4/).className).not.toContain("is-decisive");
  });
});
