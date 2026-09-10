import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import Captain from "@/components/Captain";
import type { CheckReport } from "@/lib/captain-check";

// L'ESPACE CAPITAINE, vu de l'écran. Ce fichier verrouille les trois partis pris que l'en-tête
// du composant énonce, et qu'un essai à la main ne verrait pas forcément :
//   1. on ne vérifie JAMAIS tout seul — la vérification coûte huit appels à un site associatif ;
//   2. ce qui va bien se replie, ce qui coince s'ouvre de lui-même ;
//   3. chaque problème porte son remède, en toutes lettres et lisible (pas dans un `title`).

function reponse(corps: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const toast = vi.fn();
const onExpired = vi.fn(() => false);

function fixture(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    date: "2026-09-04",
    time: "20:00",
    round: "J1",
    opponent: "Squash Club de Rennes",
    home: true,
    status: "done",
    teamId: "t1",
    teamName: "Équipe 1",
    matchCount: 1,
    checkedAt: null,
    problems: null,
    ...over,
  };
}

const rapport = (over: Partial<CheckReport> = {}): CheckReport => ({
  checkedAt: "2026-09-10T10:00:00.000Z",
  players: [
    {
      order: 1,
      side: "home",
      name: "Jean Dupont",
      verdict: "found",
      fedName: "DUPONT JEAN",
      clt: "5A",
      licence: "0124215",
      club: "Squash de l yvette",
      hint: null,
    },
    {
      order: 1,
      side: "away",
      name: "Paul Martin",
      verdict: "found",
      fedName: "MARTIN PAUL",
      clt: "4C",
      licence: "0999999",
      club: "Squash Club de Rennes",
      hint: null,
    },
  ],
  scores: [
    { order: 1, ok: true, problem: null, gamesHome: 3, gamesAway: 0, winner: "home" },
  ],
  tie: { ok: true, home: 1, away: 0, undecided: 0, problem: null },
  ...over,
});

/** Le même rapport, avec un joueur de chez nous introuvable chez la fédération. */
const introuvable = (): CheckReport =>
  rapport({
    players: [
      {
        order: 1,
        side: "home",
        name: "Jean Dupont",
        verdict: "unknown",
        fedName: null,
        clt: null,
        licence: null,
        club: null,
        hint: "Introuvable chez la fédération. Le plus souvent : l'orthographe diffère.",
      },
    ],
  });

let fetchMock: ReturnType<typeof vi.fn>;

/** Monte l'écran avec une liste, puis un rapport rendu par le GET de détail. */
function monte(fixtures: Record<string, unknown>[], report: CheckReport | null = null) {
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === "/api/captain") return reponse({ teams: [{ id: "t1", name: "Équipe 1" }], fixtures });
    if (init?.method === "POST") return reponse({ report: report ?? rapport() });
    return reponse({ report });
  });
  vi.stubGlobal("fetch", fetchMock);
  return render(<Captain toast={toast} onExpired={onExpired} />);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toast.mockClear();
});

describe("Captain — la liste", () => {
  it("annonce une rencontre jamais vérifiée comme « à vérifier », jamais comme prête", async () => {
    monte([fixture()]);
    await souffle();
    expect(screen.getByText("à vérifier")).toBeTruthy();
    expect(screen.queryByText(/prêt/)).toBeNull();
  });

  it("distingue « vérifiée, rien à signaler » de « des points à régler »", async () => {
    monte([
      fixture({ id: "f1", problems: 0, checkedAt: "2026-09-10T10:00:00.000Z" }),
      fixture({ id: "f2", opponent: "Montigny", problems: 3, checkedAt: "2026-09-10T10:00:00.000Z" }),
    ]);
    await souffle();
    expect(screen.getByText("✓ prêt")).toBeTruthy();
    expect(screen.getByText("3 à régler")).toBeTruthy();
  });

  it("aucune rencontre → le dit, plutôt qu'un écran vide", async () => {
    monte([]);
    await souffle();
    expect(screen.getByText(/Aucune rencontre/)).toBeTruthy();
  });
});

describe("Captain — le détail", () => {
  const ouvrir = async () => {
    fireEvent.click(screen.getByRole("button", { name: /Squash Club de Rennes/ }));
    await souffle();
  };

  // PARTI PRIS N°1. Ouvrir une rencontre relit le dernier rapport ; cela ne doit jamais
  // déclencher les huit recherches chez la fédération.
  it("ouvrir une rencontre NE lance PAS la vérification", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(0);
    expect(screen.getByText("Pas encore vérifiée.")).toBeTruthy();
  });

  it("le bouton lance la vérification et affiche le verdict", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    expect(screen.getByText(/Rien à signaler/)).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("ok", expect.stringContaining("Rien à signaler"));
  });

  // PARTI PRIS N°2. Une checklist où tout crie ne se lit plus : le simple réglé reste fermé…
  it("un simple sans souci se replie", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    // Rien à signaler : les noms des joueurs ne sont pas dépliés.
    expect(screen.queryByText(/Jean Dupont/)).toBeNull();
  });

  // …et celui qui coince s'ouvre SANS qu'on le touche : c'est la moitié qui compte.
  it("un simple à problème s'ouvre de lui-même", async () => {
    monte([fixture()], introuvable());
    await souffle();
    await ouvrir(); // le rapport est déjà là, relu — aucun clic sur « Vérifier »
    expect(screen.getByText(/Jean Dupont/)).toBeTruthy();
    expect(screen.getByText(/l'orthographe diffère/)).toBeTruthy();
  });

  // PARTI PRIS N°3. « Introuvable » sans la suite renvoie chercher au mauvais endroit — et le
  // remède doit être LISIBLE, pas caché dans un `title` qui ne se déclenche jamais au doigt.
  it("un problème porte son remède en toutes lettres", async () => {
    const abime = rapport({
      players: [
        {
          order: 1,
          side: "away",
          name: "Paul Martin",
          verdict: "unknown",
          fedName: null,
          clt: null,
          licence: null,
          club: null,
          hint: "Introuvable dans le club adverse. Vérifie l'orthographe relevée sur la feuille.",
        },
      ],
    });
    monte([fixture()], abime);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Revérifier/ }));
    await souffle();
    expect(screen.getByText(/Vérifie l'orthographe relevée sur la feuille/)).toBeTruthy();
  });

  it("montre le NOM FÉDÉRAL d'un joueur trouvé — c'est celui à recopier", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    // Le simple est replié (rien à signaler) : on le rouvre par sa pastille.
    fireEvent.click(screen.getByRole("button", { name: /Détail du simple n°1/ }));
    expect(screen.getByText(/DUPONT JEAN/)).toBeTruthy();
    expect(screen.getByText(/MARTIN PAUL/)).toBeTruthy();
  });

  it("le compte de la rencontre est affiché avec son problème quand il y en a un", async () => {
    const incomplet = rapport({
      tie: { ok: false, home: 1, away: 0, undecided: 1, problem: "1 simple(s) sans vainqueur." },
    });
    monte([fixture()], incomplet);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Revérifier/ }));
    await souffle();
    const tie = document.querySelector(".cap-tie") as HTMLElement;
    expect(within(tie).getByText("1 – 0")).toBeTruthy();
    expect(within(tie).getByText(/sans vainqueur/)).toBeTruthy();
  });

  it("une erreur serveur passe par le toast, sans casser l'écran", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fetchMock.mockImplementationOnce(async () =>
      reponse({ error: "squashnet est injoignable" }, false, 502),
    );
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    expect(toast).toHaveBeenCalledWith("err", "squashnet est injoignable");
    expect(screen.getByText("Pas encore vérifiée.")).toBeTruthy();
  });

  it("on revient à la liste sans perdre l'écran", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Toutes mes rencontres/ }));
    await souffle();
    expect(screen.getByText("à vérifier")).toBeTruthy();
  });
});
