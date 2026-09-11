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
      rangM: 120,
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
      rangM: 80,
      licence: "0999999",
      club: "Squash Club de Rennes",
      hint: null,
    },
  ],
  scores: [
    {
      order: 1,
      ok: true,
      problem: null,
      gamesHome: 3,
      gamesAway: 0,
      winner: "home",
      games: [
        { home: 11, away: 9 },
        { home: 11, away: 6 },
        { home: 12, away: 10 },
      ],
    },
  ],
  tie: { ok: true, home: 1, away: 0, undecided: 0, problem: null },
  awayOrder: { status: "ok", problem: null },
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
        rangM: null,
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

  // DIX SECONDES SANS RIEN À L'ÉCRAN SE LISENT « C'EST PLANTÉ ». La roue dit que ça travaille,
  // le texte dit combien de temps et pourquoi — la roue seule ne répond ni à l'un ni à l'autre.
  it("montre une roue ET une explication pendant l'attente, puis les retire", async () => {
    // Une vérification qu'on tient ouverte, pour observer l'état intermédiaire.
    let debloque!: (r: Response) => void;
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (debloque = resolve)),
    );

    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    expect(document.querySelector(".cap-spinner")).not.toBeNull();
    // `role="status"` : l'attente est ANNONCÉE, là où une roue `aria-hidden` n'apprend rien à
    // un lecteur d'écran.
    expect(within(screen.getByRole("status")).getByText(/quelques secondes/)).toBeTruthy();
    // Et le bouton est inerte : deux vérifications en vol, c'est seize appels à la fédération.
    expect((screen.getByRole("button", { name: /Vérification…/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    debloque(reponse({ report: rapport() }));
    await souffle();
    expect(document.querySelector(".cap-spinner")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
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

  // PARTI PRIS N°2. L'écran est AUSSI la feuille de match : on le garde ouvert à côté du
  // formulaire fédéral et on recopie. Tout ce qui se recopie est donc toujours visible — replier
  // un simple propre obligerait à le rouvrir pour saisir, soit le geste qu'on veut éviter.
  it("le récapitulatif est TOUJOURS visible, y compris sur un simple sans souci", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    // UNE SEULE identité par joueur : la FÉDÉRALE, celle qu'attend le formulaire. Le nom saisi
    // chez nous ne s'affiche plus — c'est la même personne, et lui seul se recopie.
    expect(screen.getByText(/DUPONT JEAN/)).toBeTruthy();
    expect(screen.getByText(/MARTIN PAUL/)).toBeTruthy();
    expect(screen.queryByText(/Jean Dupont/)).toBeNull();
    // Le club prend la place libérée, et dit le camp sans qu'on écrive « nous » / « eux ».
    expect(screen.getByText(/Squash de l yvette/)).toBeTruthy();
    expect(screen.getByText(/Squash Club de Rennes/, { selector: ".cap-club" })).toBeTruthy();
    // Classement, rang mixte et licence sur une ligne — sans le mot « licence », qui n'apporte
    // rien à côté d'un numéro qu'on reconnaît.
    expect(screen.getByText(/5A #120 · 0124215/)).toBeTruthy();
  });

  // LES POINTS, JEU PAR JEU — la ligne qu'on transcrit chez la ligue.
  it("affiche le détail point par point de chaque simple", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    expect(screen.getByText("11-9")).toBeTruthy();
    expect(screen.getByText("11-6")).toBeTruthy();
    expect(screen.getByText("12-10")).toBeTruthy();
    // Et le total en jeux, qui reste le chiffre du simple.
    expect(screen.getByText("3 – 0")).toBeTruthy();
  });

  it("un simple à problème montre son remède à côté du récapitulatif", async () => {
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
          rangM: null,
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

  // L'ORDRE DES SIMPLES D'EN FACE — le contrôle ne parle QUE s'il a quelque chose à dire.
  it("se tait sur l'ordre adverse quand il est conforme", async () => {
    monte([fixture()]);
    await souffle();
    await ouvrir();
    fireEvent.click(screen.getByRole("button", { name: /Vérifier la rencontre/ }));
    await souffle();
    expect(document.querySelector(".cap-ordre")).toBeNull();
  });

  it("signale un ordre adverse rompu, sans accuser", async () => {
    const rompu = rapport({
      awayOrder: {
        status: "violation",
        problem: "À vérifier sur la feuille de match — MARTIN PAUL (4C) est mieux classé…",
      },
    });
    monte([fixture()], rompu);
    await souffle();
    await ouvrir();
    expect(screen.getByText(/À vérifier sur la feuille de match/)).toBeTruthy();
    expect(document.querySelector(".cap-ordre-ko")).not.toBeNull();
  });

  // « On n'a pas pu vérifier » n'est pas « ils ont mal composé » : pas de rouge, pas d'accusation.
  it("un ordre non vérifiable reste une note, pas une alerte", async () => {
    const flou = rapport({
      awayOrder: { status: "unverifiable", problem: "Ordre des simples adverses non vérifié : 1 joueur…" },
    });
    monte([fixture()], flou);
    await souffle();
    await ouvrir();
    expect(screen.getByText(/non vérifié/)).toBeTruthy();
    expect(document.querySelector(".cap-ordre-ko")).toBeNull();
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
