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

describe("la ligne porte l'issue, et l'ordre met le passé en dernier", () => {
  const issue = (result: string) => ({
    result,
    leaguePoints: result === "win" ? 3 : result === "loss" ? 0 : 2,
    matches: { home: 2, away: 2 },
    games: { home: 9, away: 8 },
    rallies: { home: 153, away: 161 },
    decidedBy: result === "win" || result === "loss" ? "matches" : "games",
  });

  it("teinte la ligne selon l'issue — gagnée, perdue, nulle", async () => {
    // Trois classes et pas cinq : le nul gagné et le nul perdu partagent la couleur du nul.
    // Deux teintes voisines ne se sépareraient pas en parcourant une liste, et la nuance est
    // déjà écrite en toutes lettres dans la ligne de résultat.
    vi.stubGlobal(
      "fetch",
      servir([
        carte({ id: "a", date: "2026-06-18", outcome: issue("win") }),
        carte({ id: "b", date: "2026-06-11", outcome: issue("loss") }),
        carte({ id: "c", date: "2026-06-04", outcome: issue("drawLost") }),
      ]),
    );
    monter();
    await waitFor(() => expect(document.querySelectorAll(".ic-row")).toHaveLength(3));
    const classes = [...document.querySelectorAll(".ic-row")].map((r) => r.className);
    expect(classes.join(" ")).toContain("ic-issue-win");
    expect(classes.join(" ")).toContain("ic-issue-loss");
    expect(classes.join(" ")).toContain("ic-issue-draw");
  });

  it("ne teinte RIEN tant que la rencontre n'est pas finie", async () => {
    vi.stubGlobal(
      "fetch",
      servir([carte({ status: "scheduled", score: { home: 0, away: 0 }, outcome: null })]),
    );
    monter();
    await waitFor(() => expect(document.querySelector(".ic-row")).toBeTruthy());
    expect(document.querySelector(".ic-row")?.className).not.toContain("ic-issue-");
  });

  it("RENVOIE LE JOUÉ EN BAS, même s'il est plus récent", async () => {
    // Le tri se faisait sur la seule date : une rencontre terminée hier passait devant
    // quatre rencontres restées sans score, et on ouvrait l'écran sur du passé.
    vi.stubGlobal(
      "fetch",
      servir([
        carte({ id: "finie", date: "2026-06-18", opponent: "Verrieres 3", outcome: issue("win") }),
        carte({
          id: "attente",
          date: "2026-06-11",
          opponent: "Liberty 2",
          status: "scheduled",
          score: { home: 0, away: 0 },
          outcome: null,
        }),
      ]),
    );
    monter();
    await waitFor(() => expect(document.querySelectorAll(".ic-row")).toHaveLength(2));
    const noms = [...document.querySelectorAll(".ic-opponent")].map((n) => n.textContent ?? "");
    expect(noms[0]).toContain("Liberty 2");
    expect(noms[1]).toContain("Verrieres 3");
  });
});
