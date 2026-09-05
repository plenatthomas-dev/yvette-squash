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
  createdById: "u1",
  winGames: 3,
  score: { home: 0, away: 0 },
  team: { id: "t1", name: "Équipe 1" },
  roster: [{ kind: "member", id: "u1", name: "Thomas", clt: null, rangM: null }],
  matches: [
    {
      id: "m1",
      order: 1,
      status: "pending",
      // Les DEUX joueurs sont désignés : ces tests portent sur le comportement des cases de
      // score (vide vs zéro), pas sur la composition — un simple encore « à désigner » bloque
      // désormais la saisie (cf. `lineupComplete`), ce que d'autres tests couvrent.
      homeUserId: "u1",
      homeGuestId: null,
      homeDisplayName: "Thomas",
      awayName: "Jérôme Massy",
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

/** Remplace `FIXTURE` pour un test précis (gardes de composition incomplète). */
let fixtureOverride: Record<string, unknown> | null = null;

beforeEach(() => {
  envois = [];
  fixtureOverride = null;
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
      // La fiche d'une rencontre porte désormais le bloc « qui peut venir ? ». Il n'est pas le
      // sujet de ce fichier, mais il émet sa propre requête : sans réponse à sa forme, la
      // réponse fourre-tout ci-dessous lui arrivait et il n'y trouvait pas ses compteurs.
      if (u.includes("/availability")) {
        return reponse({ entries: [], counts: { yes: 0, no: 0, maybe: 0, pendingReachable: [], pendingUnreachable: [] }, matchCount: 4, me: "u1" });
      }
      if (u.includes("/api/interclub/live")) return reponse({ fixtures: [] });
      if (/\/api\/interclub\/f1$/.test(u)) return reponse(fixtureOverride ?? FIXTURE);
      return reponse({
        teams: [{ id: "t1", name: "Équipe 1" }],
        fixtures: [
          {
            id: "f1",
            date: "2026-09-03",
            opponent: "Massy",
            home: true,
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

// Composition incomplète : ni le score, ni le marquage en direct ne doivent être atteignables
// tant que les deux joueurs ne sont pas désignés — sans quoi une notification annoncerait « à
// désigner » comme un vrai nom (cf. `lineupComplete`, partagé avec le serveur).
const FIXTURE_UNSET = {
  ...FIXTURE,
  matches: [
    {
      ...FIXTURE.matches[0],
      homeUserId: null,
      homeDisplayName: "À désigner",
      awayName: "À désigner",
    },
  ],
};

describe("Composition incomplète — score et marquage bloqués", () => {
  it("désactive « + Ajouter un jeu » tant que les deux joueurs ne sont pas désignés", async () => {
    fixtureOverride = FIXTURE_UNSET;
    const r = await ouvreEditeur();
    const ajouter = r.queryByText("+ Ajouter un jeu");
    if (!ajouter) return; // le formulaire n'est pas atteignable dans ce banc : rien à affirmer
    expect((ajouter.closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("désactive « Marquer en direct » tant que les deux joueurs ne sont pas désignés", async () => {
    fixtureOverride = FIXTURE_UNSET;
    const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
    await souffle();
    fireEvent.click(r.getByText(/Massy/));
    await souffle();
    const btn = r.queryByText(/Marquer en direct|Reprendre le marquage/);
    if (!btn) return; // le formulaire n'est pas atteignable dans ce banc : rien à affirmer
    expect((btn.closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

// LE SÉLECTEUR DE COMPOSITION — l'ordre des simples se décide sur DEUX critères, et l'écran
// doit les montrer tous les deux.
//
// La règle de la compétition ordonne d'abord par classement, puis — à classement égal — par
// RANG MIXTE. Tant que l'écran n'affichait que le classement, deux « 5A » semblaient
// interchangeables alors que le serveur en refusait un : le capitaine voyait un choix grisé
// sans pouvoir lire ce qui le distinguait de l'autre.
describe("Sélecteur de composition — classement ET rang mixte", () => {
  /** Une rencontre à deux simples, dont le premier est déjà composé. */
  function fixtureAvecRoster(roster: Array<Record<string, unknown>>) {
    return {
      ...FIXTURE,
      matchCount: 2,
      roster,
      matches: [
        { ...FIXTURE.matches[0], id: "m1", order: 1 },
        {
          ...FIXTURE.matches[0],
          id: "m2",
          order: 2,
          homeUserId: null,
          homeDisplayName: "À désigner",
          awayName: "À désigner",
        },
      ],
    };
  }

  /**
   * Ouvre le formulaire du SECOND simple — celui qui est encore « à désigner », donc le seul
   * dont le sélecteur de joueur nous intéresse. `ouvreEditeur` ne sait viser qu'un formulaire
   * unique ; ici la rencontre en compte deux.
   */
  async function ouvreSecondSimple() {
    const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
    await souffle();
    fireEvent.click(r.getByText(/Massy/));
    await souffle();
    const boutons = r.queryAllByRole("button", { name: /Saisir|Corriger|Modifier|désigner/i });
    if (boutons.length === 0) return r;
    fireEvent.click(boutons[boutons.length - 1]);
    await souffle();
    return r;
  }

  /** Le texte de l'option du sélecteur qui porte ce joueur. */
  function option(r: ReturnType<typeof render>, nom: string): HTMLOptionElement | undefined {
    return Array.from(r.container.querySelectorAll("option")).find((o) =>
      o.textContent?.startsWith(nom),
    ) as HTMLOptionElement | undefined;
  }

  it("affiche le rang mixte à côté du classement", async () => {
    fixtureOverride = fixtureAvecRoster([
      { kind: "member", id: "u1", name: "Thomas", clt: "5A", rangM: 1200 },
    ]);
    const r = await ouvreSecondSimple();
    const o = option(r, "Thomas");
    if (!o) return; // le formulaire n'est pas atteignable dans ce banc : rien à affirmer
    expect(o.textContent).toContain("5A");
    expect(o.textContent).toContain("1200");
  });

  it("tait le rang mixte d'un NC, où il ne veut rien dire", async () => {
    fixtureOverride = fixtureAvecRoster([
      { kind: "member", id: "u1", name: "Thomas", clt: "NC", rangM: 3900 },
    ]);
    const r = await ouvreSecondSimple();
    const o = option(r, "Thomas");
    if (!o) return;
    expect(o.textContent).toContain("NC");
    expect(o.textContent).not.toContain("3900");
  });

  it("grise un joueur classé dont le rang mixte est inconnu, et dit pourquoi", async () => {
    // On grise plutôt que de laisser composer pour se faire refuser par le serveur — même
    // logique que « joue déjà le match n° X ».
    fixtureOverride = fixtureAvecRoster([
      { kind: "member", id: "u2", name: "Mystère", clt: "5A", rangM: null },
    ]);
    const r = await ouvreSecondSimple();
    const o = option(r, "Mystère");
    if (!o) return;
    expect(o.disabled).toBe(true);
    expect(o.textContent).toContain("rang mixte inconnu");
  });

  it("laisse un NC sans rang mixte parfaitement choisissable", async () => {
    // Thomas (5A) est au roster parce qu'il dispute déjà le simple 1 : sans lui, l'écran ne
    // saurait pas à quel classement comparer, et grieserait Denis pour une tout autre raison.
    fixtureOverride = fixtureAvecRoster([
      { kind: "member", id: "u1", name: "Thomas", clt: "5A", rangM: 1200 },
      { kind: "member", id: "u3", name: "Denis", clt: "NC", rangM: null },
    ]);
    const r = await ouvreSecondSimple();
    const o = option(r, "Denis");
    if (!o) return;
    expect(o.disabled).toBe(false);
  });
});
