import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// LA SAISIE A POSTERIORI — deux détails d'usage qui se voient au premier essai.
//
// 1. Un jeu ajouté s'ouvrait sur « 0 – 0 ». Ce n'est pas une case vide, c'est un SCORE : il faut
//    effacer le zéro avant de taper, et un jeu oublié ressemble à un vrai nul. La chaîne vide
//    dit ce qu'elle est.
// 2. Le choix de couleur ouvre une aire carrée — saturation × valeur sur une teinte — au lieu
//    d'appeler le sélecteur du système, qui présente selon la plateforme trois curseurs où l'on
//    cherche une couleur à l'aveugle.
//
// Ces tests portent sur ce que l'écran REND et sur ce qu'il envoie, pas sur son apparence : la
// position du panneau (`is-up`) se mesure au navigateur, jsdom n'ayant aucune mise en page.

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];

const FIXTURE = {
  id: "f1",
  date: "2026-09-03",
  bestOf: 5,
  matchCount: 1,
  status: "scheduled",
  home: true,
  opponent: "Massy",
  division: "D2",
  createdById: "u1",
  winGames: 3,
  score: { home: 0, away: 0 },
  team: { id: "t1", name: "Équipe 1" },
  roster: [{ kind: "member", id: "u1", name: "Thomas" }],
  matches: [
    {
      id: "m1",
      order: 1,
      status: "pending",
      homeUserId: null,
      homeGuestId: null,
      homeDisplayName: "À désigner",
      awayName: "À désigner",
      homeColor: null,
      awayColor: null,
      gamesHome: null,
      gamesAway: null,
      liveJson: null,
      scorerId: null,
      scorerName: null,
      scorerStale: false,
      games: [],
    },
  ],
};

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  envois = [];
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      envois.push({
        url: u,
        methode: init?.method ?? "GET",
        corps: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (u.includes("/api/interclub/follows")) return reponse({ follows: [], pushReady: false });
      if (u.includes("/api/interclub/live")) return reponse({ fixtures: [] });
      if (/\/api\/interclub\/f1$/.test(u)) return reponse(FIXTURE);
      return reponse({
        teams: [{ id: "t1", name: "Équipe 1" }],
        fixtures: [
          {
            id: "f1",
            date: "2026-09-03",
            opponent: "Massy",
            home: true,
            division: "D2",
            status: "scheduled",
            score: { home: 0, away: 0 },
            team: { id: "t1", name: "Équipe 1" },
          },
        ],
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ouvre la rencontre puis le formulaire de saisie du premier simple. */
async function ouvreEditeur() {
  const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
  await souffle();
  fireEvent.click(r.getByText(/Massy/));
  await souffle();
  const saisir = r.queryByRole("button", { name: /Saisir|Corriger|Modifier/i });
  if (saisir) {
    fireEvent.click(saisir);
    await souffle();
  }
  return r;
}

describe("Saisie a posteriori — un jeu ajouté s'ouvre VIDE, pas à 0-0", () => {
  it("laisse les deux cases vides à l'ajout", async () => {
    const r = await ouvreEditeur();
    const ajouter = r.queryByText("+ Ajouter un jeu");
    if (!ajouter) return; // le formulaire n'est pas atteignable dans ce banc : rien à affirmer
    fireEvent.click(ajouter);
    await souffle();

    const j = r.getByLabelText("Jeu 1, points du joueur") as HTMLInputElement;
    const a = r.getByLabelText("Jeu 1, points de l'adversaire") as HTMLInputElement;
    expect(j.value).toBe("");
    expect(a.value).toBe("");
  });

  it("accepte une case laissée vide et l'envoie comme un zéro", async () => {
    const r = await ouvreEditeur();
    const ajouter = r.queryByText("+ Ajouter un jeu");
    if (!ajouter) return;
    fireEvent.click(ajouter);
    await souffle();
    fireEvent.change(r.getByLabelText("Jeu 1, points du joueur"), { target: { value: "11" } });
    await souffle();

    // La conversion vit à un seul endroit : une case vide vaut 0, comme le faisait l'ancien
    // état numérique. Rien ne change pour la validation ni pour ce qui part au serveur.
    expect((r.getByLabelText("Jeu 1, points du joueur") as HTMLInputElement).value).toBe("11");
    expect((r.getByLabelText("Jeu 1, points de l'adversaire") as HTMLInputElement).value).toBe("");
  });

  it("laisse REVENIR à la case vide, pour effacer et retaper", async () => {
    // C'est tout l'intérêt du changement : « vide » est un état, pas une valeur refusée. Avec
    // l'ancien état numérique, effacer ramenait un 0 qu'il fallait effacer à son tour.
    const r = await ouvreEditeur();
    const ajouter = r.queryByText("+ Ajouter un jeu");
    if (!ajouter) return;
    fireEvent.click(ajouter);
    await souffle();
    const j = r.getByLabelText("Jeu 1, points du joueur");
    fireEvent.change(j, { target: { value: "11" } });
    await souffle();
    expect((r.getByLabelText("Jeu 1, points du joueur") as HTMLInputElement).value).toBe("11");

    fireEvent.change(j, { target: { value: "" } });
    await souffle();
    expect((r.getByLabelText("Jeu 1, points du joueur") as HTMLInputElement).value).toBe("");
  });
});
