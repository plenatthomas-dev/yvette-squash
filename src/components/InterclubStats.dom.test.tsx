import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { InterclubStats } from "@/components/InterclubStats";

// LE PALMARÈS, À L'ÉCRAN.
//
// Trois propriétés tiennent ici, et aucune ne se relit dans le JSX :
//
//  1. RIEN N'EST CHARGÉ TANT QUE LE BLOC EST FERMÉ. La requête joint les simples et leur jeu
//     par jeu sur toute l'histoire du club. La payer à chaque affichage de l'écran interclub,
//     pour un bloc que presque personne n'ouvre, serait un coût permanent sans contrepartie.
//  2. ELLE N'EST PAYÉE QU'UNE FOIS. Replier puis déplier ne relance rien : `data` non nul vaut
//     « déjà chargé », et sans cette garde le bloc rechargerait à chaque coup d'œil.
//  3. « 0 % » NE S'ÉCRIT PAS SUR ZÉRO MATCH. Un joueur inscrit mais jamais aligné n'a pas
//     perdu ; l'écrire 0 % l'accuserait de ce qu'il n'a pas fait.

const tally = (won: number, lost: number) => ({ won, lost, diff: won - lost });

const ligne = (over: Record<string, unknown> = {}) => ({
  key: "u:u1",
  name: "Thomas",
  isMember: true,
  played: 4,
  won: 3,
  lost: 1,
  winRate: 0.75,
  games: tally(10, 5),
  rallies: tally(180, 140),
  ...over,
});

/** Les appels réellement partis, dans l'ordre — c'est la mesure des propriétés 1 et 2. */
let appels: string[] = [];
let charge: { rows: unknown[]; seasons: string[] };

beforeEach(() => {
  appels = [];
  charge = { rows: [ligne()], seasons: ["2025-2026", "2024-2025"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      appels.push(String(url));
      return { ok: true, status: 200, json: async () => charge } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rendre = (teamId: string | null = null) =>
  render(<InterclubStats teamId={teamId} onExpired={() => false} />);

/** Le `<details>` de jsdom n'ouvre pas tout seul au clic : on pose `open` et on notifie. */
const ouvrir = async (n = 0) => {
  const bloc = document.querySelectorAll("details.ic-stats")[n] as HTMLDetailsElement;
  bloc.open = true;
  bloc.dispatchEvent(new Event("toggle", { bubbles: false }));
  return bloc;
};

describe("InterclubStats", () => {
  it("NE CHARGE RIEN tant que le bloc est fermé", () => {
    rendre();
    expect(screen.getByText("Statistiques des joueurs")).toBeTruthy();
    expect(appels).toEqual([]);
  });

  it("charge à la première ouverture, et rend le palmarès", async () => {
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    expect(appels).toHaveLength(1);
    expect(screen.getByText("75 %")).toBeTruthy();
    // Le différentiel de jeux est SIGNÉ : « 5 » se lirait comme un total de jeux gagnés.
    expect(screen.getByText("+5")).toBeTruthy();
  });

  it("ne recharge pas quand on replie puis rouvre", async () => {
    rendre();
    const bloc = await ouvrir();
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    bloc.open = false;
    bloc.dispatchEvent(new Event("toggle"));
    bloc.open = true;
    bloc.dispatchEvent(new Event("toggle"));
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    expect(appels).toHaveLength(1);
  });

  it("porte l'équipe de l'onglet dans la requête", async () => {
    rendre("t7");
    await ouvrir();
    await waitFor(() => expect(appels).toHaveLength(1));
    expect(appels[0]).toContain("teamId=t7");
  });

  it("SUIT L'ONGLET : changer d'équipe recharge le palmarès déjà ouvert", async () => {
    // Monter directement avec « t7 » ne prouve rien : le composant n'a pas de `key`, il n'est
    // jamais remonté. C'est le CHANGEMENT de `teamId` sur un composant vivant qui doit relancer
    // la requête — sans quoi le classement et les rencontres changent d'équipe et le palmarès
    // reste celui de l'onglet précédent, sans rien qui le signale.
    const { rerender } = rendre(null);
    await ouvrir();
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    expect(appels[0]).not.toContain("teamId=");

    rerender(<InterclubStats teamId="t7" onExpired={() => false} />);
    await waitFor(() => expect(appels).toHaveLength(2));
    expect(appels[1]).toContain("teamId=t7");
  });

  it("ne charge RIEN en changeant d'onglet tant que le bloc n'a pas été ouvert", async () => {
    // Le corollaire : un bloc jamais déplié ne doit rien coûter, y compris quand on navigue
    // d'un onglet à l'autre. Sinon l'effet ferait payer la requête à chaque écran interclub.
    const { rerender } = rendre(null);
    rerender(<InterclubStats teamId="t7" onExpired={() => false} />);
    await waitFor(() => expect(screen.getByText("Statistiques des joueurs")).toBeTruthy());
    expect(appels).toEqual([]);
  });

  it("recharge en changeant de saison, et le dit au serveur", async () => {
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2024-2025" } });
    await waitFor(() => expect(appels).toHaveLength(2));
    expect(appels[1]).toContain("season=2024-2025");
  });

  it("écrit « — » et non « 0 % » sur un joueur jamais aligné", async () => {
    charge = {
      rows: [ligne({ played: 0, won: 0, lost: 0, winRate: null, games: tally(0, 0) })],
      seasons: [],
    };
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText("Thomas")).toBeTruthy());
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("0 %")).toBeNull();
  });

  // Un joueur sans compte joue les mêmes matchs et compte pareil dans le palmarès. La mention
  // n'est pas un rang inférieur : elle évite seulement qu'on le cherche dans l'annuaire.
  it("signale le joueur hors appli sans le sortir du classement", async () => {
    charge = { rows: [ligne({ key: "g:g1", name: "Paul", isMember: false })], seasons: [] };
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText("Paul")).toBeTruthy());
    expect(screen.getByText("hors appli")).toBeTruthy();
  });

  it("dit qu'il n'y a rien plutôt que d'afficher un tableau vide", async () => {
    charge = { rows: [], seasons: [] };
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText(/Aucun match terminé/)).toBeTruthy());
    expect(document.querySelector(".ic-stats-table")).toBeNull();
  });

  // Le silence serait indiscernable d'un club sans aucun match joué — le pire des deux, parce
  // qu'il est crédible.
  it("dit l'échec réseau au lieu de se taire", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    rendre();
    await ouvrir();
    await waitFor(() => expect(screen.getByText(/indisponibles/)).toBeTruthy());
  });
});
