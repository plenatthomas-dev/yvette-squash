import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// ============================================================================
//  LE CALENDRIER COMMENÇAIT À J13.
//
//  L'appel de liste partait NU, donc avec le défaut de la route : vingt rencontres, toutes
//  équipes confondues. C'était large tant qu'une saison en comptait cinq par équipe. La poule
//  2026-27 en compte VINGT, et nos deux équipes y jouent — quarante lignes pour vingt servies.
//
//  Et la coupe tombait du mauvais côté : le serveur trie par date DÉCROISSANTE, donc les vingt
//  servies étaient les vingt DERNIÈRES journées de la saison. Ce qui manquait était exactement
//  ce qu'on vient chercher en ouvrant l'écran — les prochaines. Le tri « à venir d'abord » du
//  composant n'y pouvait rien : on ne trie pas ce qu'on n'a pas reçu.
//
//  Rien ne le disait. `hasMore` était calculé par la route et lu par personne.
// ============================================================================

const EQUIPES = [
  { id: "t1", name: "Équipe 1", captainId: null, captainName: null },
  { id: "t2", name: "Équipe 2", captainId: null, captainName: null },
];

/** Une saison réelle : vingt journées par équipe, la poule 2026-27 telle qu'elle est publiée. */
function saisonComplete() {
  const lignes = [];
  for (const equipe of EQUIPES) {
    for (let j = 1; j <= 20; j++) {
      lignes.push({
        id: `${equipe.id}-j${j}`,
        // Décroissant, comme la route les rend : J1 est la DERNIÈRE ligne du tableau.
        date: `2027-${String(4 - Math.floor((j - 1) / 7)).padStart(2, "0")}-${String(28 - ((j - 1) % 7) * 4).padStart(2, "0")}`,
        time: "20:00",
        venue: null,
        venueAddress: null,
        round: `J${j}`,
        dateConfirmed: true,
        team: equipe,
        opponent: `Adversaire ${j}`,
        home: j % 2 === 0,
        matchCount: 4,
        status: "scheduled",
        score: { home: 0, away: 0 },
      });
    }
  }
  return lignes;
}

let urls: string[] = [];

/**
 * Le faux serveur APPLIQUE LA LIMITE, exactement comme la route.
 *
 * Un bouchon qui rendrait tout quoi qu'on demande laisserait passer la régression : l'écran
 * afficherait les quarante lignes même en demandant vingt, et le test serait vert sur le code
 * fautif. C'est donc ici que se joue sa valeur — le défaut vit dans l'URL demandée, pas dans le
 * rendu, et seul un bouchon qui coupe le rend visible.
 *
 * Défaut à VINGT et tri par date DÉCROISSANTE : les deux valeurs de `GET /api/interclub`.
 */
function servir(fixtures: { date: string }[], forceHasMore = false) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    // Le bandeau « en direct » interroge la MÊME racine : lui servir la charge de la liste
    // lui donnerait des rencontres sans simples, et il planterait sur `f.matches.map`.
    const liste = /\/api\/interclub(\?|$)/.test(url);
    const demande = Number(new URLSearchParams(url.split("?")[1] ?? "").get("limit"));
    const limite = Number.isFinite(demande) && demande > 0 ? Math.min(demande, 100) : 20;
    const triees = [...fixtures].sort((a, b) => b.date.localeCompare(a.date));
    const servies = triees.slice(0, limite);
    const corps = liste
      ? {
          teams: EQUIPES,
          fixtures: servies,
          follows: [],
          pushReady: false,
          hasMore: forceHasMore || triees.length > limite,
        }
      : { fixtures: [], follows: [], pushReady: false };
    return new Response(JSON.stringify(corps), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  urls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const monter = () => render(<Interclub toast={() => {}} onExpired={() => false} />);

describe("la liste des rencontres n'est pas coupée en silence", () => {
  it("⚠️ demande une profondeur qui couvre une SAISON ENTIÈRE À DEUX ÉQUIPES", async () => {
    vi.stubGlobal("fetch", servir(saisonComplete()));
    monter();

    await waitFor(() => expect(urls.some((u) => u.includes("/api/interclub"))).toBe(true));
    const liste = urls.find((u) => /\/api\/interclub(\?|$)/.test(u))!;

    // Le chiffre est lu dans l'URL plutôt qu'écrit en dur : ce que ce test tient, c'est qu'il
    // couvre la saison, pas qu'il vaille cent. Nu (donc à vingt), l'appel échoue ici.
    const limite = Number(new URLSearchParams(liste.split("?")[1] ?? "").get("limit"));
    expect(limite).toBeGreaterThanOrEqual(40);
  });

  it("affiche les VINGT journées de chaque équipe, J1 comprise", async () => {
    vi.stubGlobal("fetch", servir(saisonComplete()));
    monter();

    // J1 est la plus ancienne des quarante : c'est précisément celle que la coupe emportait,
    // et c'est la prochaine à jouer. Sa présence est donc le vrai test.
    await waitFor(() => expect(screen.getAllByText(/\bJ1\b/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/\bJ20\b/).length).toBeGreaterThan(0);
  });

  it("DIT quand la route a coupé, au lieu de laisser croire la liste entière", async () => {
    vi.stubGlobal("fetch", servir(saisonComplete(), true));
    monter();

    await waitFor(() =>
      expect(screen.getByText(/les plus récentes sont affichées/i)).toBeTruthy(),
    );
  });

  it("ne dit rien quand elle n'a pas coupé — une mention permanente ne serait plus lue", async () => {
    vi.stubGlobal("fetch", servir(saisonComplete()));
    monter();

    await waitFor(() => expect(screen.getAllByText(/\bJ1\b/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/les plus récentes sont affichées/i)).toBeNull();
  });
});
