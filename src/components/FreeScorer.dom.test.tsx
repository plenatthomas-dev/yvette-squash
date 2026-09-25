import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import FreeScorer from "@/components/FreeScorer";
import Tournament from "@/components/Tournament";
import { CURRENT_KEY, HISTORY_KEY, tournamentKey } from "@/lib/free-scorer";

// LE MARQUEUR LIBRE NE PARLE À PERSONNE : tout ce qu'il promet se vérifie donc dans le
// stockage du téléphone. Un rechargement en plein match ne doit rien coûter, un stockage refusé
// ne doit pas empêcher de compter, et un match de tournoi ne purge son journal que lorsque le
// serveur a pris le résultat.

vi.mock("@/components/FeatureProvider", () => ({
  useFeatures: () => ({ scorer: true }),
}));

const clic = (el: HTMLElement) => act(() => fireEvent.click(el));
const bouton = (name: string | RegExp) => screen.getByRole("button", { name });

/** Désigne le premier serveur (joueur 1, carré droit). */
function engager(nom: string) {
  clic(bouton(`${nom} · droite`));
}

/** Marque `n` points pour `nom`, en franchissant pause et choix de carré s'ils surgissent. */
function points(nom: string, n: number) {
  for (let i = 0; i < n; i++) {
    const pause = screen.queryByRole("button", { name: "Reprendre maintenant" });
    if (pause) clic(pause);
    const carre = screen.queryByRole("button", { name: "Carré droit" });
    if (carre) clic(carre);
    clic(bouton(`Point pour ${nom}`));
  }
}

function pointsAffiches(): string[] {
  return [...document.querySelectorAll(".ics-points")].map((e) => e.textContent ?? "");
}

describe("FreeScorer — vue « Marqueur »", () => {
  const toast = vi.fn();

  function commencer() {
    render(<FreeScorer toast={toast} />);
    fireEvent.change(screen.getByLabelText("Joueur 1"), { target: { value: "Paul" } });
    fireEvent.change(screen.getByLabelText("Joueur 2"), { target: { value: "Marc" } });
    clic(bouton("Commencer"));
  }

  it("un rechargement en plein match reprend au même score", () => {
    commencer();
    engager("Paul");
    points("Paul", 3);
    points("Marc", 1);
    expect(pointsAffiches()).toEqual(["3", "1"]);

    // Onglet tué, appli rouverte.
    cleanup();
    render(<FreeScorer toast={toast} />);
    expect(screen.getByText("Match en cours")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commencer" })).toBeNull();
    clic(bouton("Reprendre"));
    expect(pointsAffiches()).toEqual(["3", "1"]);
  });

  it("« Retour » garde le match, « Abandonner » demande confirmation", () => {
    commencer();
    engager("Paul");
    points("Paul", 2);
    clic(bouton("← Retour"));
    expect(screen.getByText("Match en cours")).toBeTruthy();
    clic(bouton("Abandonner"));
    expect(localStorage.getItem(CURRENT_KEY)).not.toBeNull();
    clic(bouton("Confirmer l'abandon"));
    expect(localStorage.getItem(CURRENT_KEY)).toBeNull();
    expect(bouton("Commencer")).toBeTruthy();
  });

  it("un match terminé passe dans l'historique et libère le match en cours", () => {
    commencer();
    engager("Paul");
    points("Paul", 22);
    expect(screen.getByText(/Paul l'emporte/)).toBeTruthy();
    clic(bouton("Terminer"));

    expect(localStorage.getItem(CURRENT_KEY)).toBeNull();
    const hist = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    expect(hist).toHaveLength(1);
    expect(screen.getAllByText("Paul bat Marc 2-0 (11-0, 11-0)").length).toBeGreaterThan(0);
    expect(bouton("Partager le résultat")).toBeTruthy();
  });

  it("stockage refusé (mode privé, quota) : on compte quand même", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      commencer();
      engager("Paul");
      points("Paul", 4);
      expect(pointsAffiches()).toEqual(["4", "0"]);
    } finally {
      set.mockRestore();
    }
  });

  it("un stockage abîmé ramène à l'écran de départ", () => {
    localStorage.setItem(CURRENT_KEY, "{pas du json");
    render(<FreeScorer toast={toast} />);
    expect(bouton("Commencer")).toBeTruthy();
  });
});

// --- Tournoi : marquer point par point, envoyer le résultat en jeux ---------------------------

const joueur = (id: string, name: string) => ({ id, name });
const detail = {
  id: "t1",
  name: "Nuit du squash",
  date: "2026-11-14",
  status: "running",
  format: "pools",
  formatLabel: "1 poule",
  targetMatches: 3,
  bestOf: 3,
  courts: 2,
  isCreator: false,
  isParticipant: true,
  players: [joueur("p1", "Marc"), joueur("p2", "Léa")],
  pools: [
    {
      label: "Poule A",
      matches: [
        {
          id: "m1",
          p1: joueur("p1", "Marc"),
          p2: joueur("p2", "Léa"),
          score1: null,
          score2: null,
          winnerId: null,
          status: "pending",
          terrain: null,
          order: null,
        },
      ],
      standings: [],
    },
  ],
  bracket: null,
  finals: null,
  canGenerateFinals: false,
  champion: null,
};

let patchOk = true;
let envois: { url: string; method?: string; body: unknown }[] = [];

function fauxFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  envois.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
  let status = 200;
  let corps: unknown = detail;
  if (url.endsWith("/api/tournaments")) {
    corps = { tournaments: [{ id: "t1", name: "Nuit du squash", date: "2026-11-14", status: "running", format: "pools", playerCount: 2 }] };
  } else if (init?.method === "PATCH") {
    status = patchOk ? 200 : 409;
    corps = patchOk ? { ok: true } : { error: "Match déjà saisi" };
  }
  return Promise.resolve(
    new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } }),
  );
}

async function ouvrirTournoi() {
  render(<Tournament toast={() => {}} onExpired={() => false} />);
  const item = await screen.findByText("Nuit du squash");
  await act(async () => {
    fireEvent.click(item);
  });
  await waitFor(() => expect(screen.getByText(/Formule :/)).toBeTruthy());
}

describe("Tournoi — « 🎯 Marquer »", () => {
  beforeEach(() => {
    envois = [];
    patchOk = true;
    vi.stubGlobal("fetch", fauxFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("envoie le résultat EN JEUX, p1 d'abord, puis purge le journal", async () => {
    await ouvrirTournoi();
    clic(bouton(/Marquer point par point : Marc contre Léa/));
    engager("Marc");
    points("Léa", 11);
    points("Marc", 22);
    expect(localStorage.getItem(tournamentKey("m1"))).not.toBeNull();

    await act(async () => {
      fireEvent.click(bouton("Envoyer le résultat"));
    });
    const patch = envois.find((e) => e.method === "PATCH");
    expect(patch?.url).toBe("/api/tournaments/t1/matches/m1");
    expect(patch?.body).toEqual({ score1: 2, score2: 1 });
    await waitFor(() => expect(localStorage.getItem(tournamentKey("m1"))).toBeNull());
    expect(document.querySelector(".ics")).toBeNull();
  });

  it("refus du serveur : le journal et l'écran restent", async () => {
    patchOk = false;
    await ouvrirTournoi();
    clic(bouton(/Marquer point par point/));
    engager("Marc");
    points("Marc", 22);
    await act(async () => {
      fireEvent.click(bouton("Envoyer le résultat"));
    });
    await waitFor(() => expect(envois.some((e) => e.method === "PATCH")).toBe(true));
    expect(localStorage.getItem(tournamentKey("m1"))).not.toBeNull();
    expect(document.querySelector(".ics")).not.toBeNull();
  });

  it("« Retour » garde le journal, et le bouton devient « Reprendre »", async () => {
    await ouvrirTournoi();
    clic(bouton(/Marquer point par point/));
    engager("Marc");
    points("Marc", 5);
    clic(bouton("← Retour"));
    clic(bouton(/Reprendre le marquage : Marc contre Léa/));
    expect(pointsAffiches()).toEqual(["5", "0"]);
  });

  it("un journal d'AUTRES joueurs (slot de tableau réattribué) n'est pas repris", async () => {
    localStorage.setItem(
      tournamentKey("m1"),
      JSON.stringify({
        id: "m1",
        startedAt: Date.now(),
        home: { name: "Zoé", color: null },
        away: { name: "Léa", color: null },
        bestOf: 3,
        events: [{ t: "serve", side: "home", box: "right" }, { t: "point", side: "home" }],
      }),
    );
    await ouvrirTournoi();
    clic(bouton(/point par point : Marc contre Léa|Reprendre le marquage : Marc contre Léa/));
    expect(pointsAffiches()).toEqual(["0", "0"]);
    expect(screen.getByText("Qui engage ?")).toBeTruthy();
  });
});
