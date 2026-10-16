import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, within } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// UNE ÉQUIPE, UNE RENCONTRE PAR JOUR — le formulaire « Nouvelle rencontre ».
//
// Le 15/10/2026, l'Équipe 1 a eu deux fiches contre CAL Squash le même soir : celle de l'import
// fédéral, avec les réponses de disponibilité, et une seconde créée au bord du terrain par
// quelqu'un qui ne l'avait pas vue, avec les scores. Le formulaire le dit désormais AVANT
// d'écrire et mène à la bonne fiche ; « Créer quand même » reste possible (double journée).

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];

const ligne = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  date: "2026-10-15",
  opponent: "CAL Squash",
  home: true,
  round: "J2",
  status: "scheduled",
  score: { home: 0, away: 0 },
  team: { id: "t1", name: "Équipe 1" },
  ...over,
});

/** La liste que `/api/interclub?limit=100` rend — surchargée par test. */
let liste: ReturnType<typeof ligne>[] = [];
/** Ce que le serveur répond à la création. */
let refusMemeJour = false;

function reponse(corps: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  envois = [];
  liste = [ligne()];
  refusMemeJour = false;
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const methode = init?.method ?? "GET";
      envois.push({ url: u, methode, corps: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.includes("/api/interclub/opponents")) return reponse({ teams: [], players: [] });
      if (u.includes("/api/interclub/follows")) return reponse({ follows: [], pushReady: false });
      if (u.includes("/api/interclub/live")) return reponse({ fixtures: [] });
      if (u === "/api/interclub" && methode === "POST") {
        if (refusMemeJour) {
          // Le serveur connaît une rencontre que la liste affichée ignorait encore.
          liste = [...liste, ligne({ id: "f2", date: "2026-10-22", opponent: "Massy", home: false, round: null })];
          return reponse(
            {
              error: "Équipe 1 a déjà une rencontre ce jour-là (se déplace à Massy).",
              code: "same_day",
              existing: { id: "f2" },
            },
            409,
          );
        }
        return reponse({ id: "neuve" }, 201);
      }
      // Une fiche ouverte : son contenu ne compte pas ici, seul l'appel qui y mène.
      if (/\/api\/interclub\/[^/?]+$/.test(u)) return reponse({ error: "absente" }, 404);
      // `canCreate` : le formulaire n'est offert qu'à l'admin.
      return reponse({ teams: [{ id: "t1", name: "Équipe 1" }], fixtures: liste, canCreate: true });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function ouvreCreation(toast = vi.fn()) {
  const r = render(<Interclub toast={toast} onExpired={() => false} />);
  await souffle();
  fireEvent.click(r.getByText(/Nouvelle rencontre/));
  await souffle();
  const dlg = within(r.getByRole("dialog", { name: "Nouvelle rencontre" }));
  const date = (iso: string) =>
    fireEvent.change(dlg.getByLabelText("Date"), { target: { value: iso } });
  fireEvent.change(dlg.getByLabelText("Club adverse"), { target: { value: "CAL Squash" } });
  return { r, dlg, date };
}

const creations = () => envois.filter((e) => e.url === "/api/interclub" && e.methode === "POST");
const lectures = () => envois.filter((e) => e.url.startsWith("/api/interclub?"));

describe("Nouvelle rencontre — une équipe, une rencontre par jour", () => {
  it("prévient quand l'équipe a déjà une rencontre ce jour-là, et dit laquelle", async () => {
    const { dlg, date } = await ouvreCreation();
    date("2026-10-15");
    await souffle();
    expect(dlg.getByRole("status").textContent).toMatch(
      /Équipe 1 a déjà une rencontre ce jour-là : reçoit CAL Squash \(J2\)\./,
    );
    expect(dlg.getByRole("button", { name: "Créer quand même" })).toBeTruthy();
  });

  it("ne dit rien un autre jour, et crée sans forcer", async () => {
    const { dlg, date } = await ouvreCreation();
    date("2026-10-16");
    await souffle();
    expect(dlg.queryByRole("status")).toBeNull();
    fireEvent.click(dlg.getByRole("button", { name: "Créer" }));
    await souffle();
    expect(creations()).toHaveLength(1);
    expect(creations()[0].corps).not.toHaveProperty("force");
  });

  it("« Ouvrir cette rencontre » ferme le formulaire et ouvre la fiche existante", async () => {
    const { r, dlg, date } = await ouvreCreation();
    date("2026-10-15");
    await souffle();
    fireEvent.click(dlg.getByRole("button", { name: "Ouvrir cette rencontre" }));
    await souffle();
    expect(r.queryByRole("dialog", { name: "Nouvelle rencontre" })).toBeNull();
    expect(envois.some((e) => e.url === "/api/interclub/f1")).toBe(true);
    expect(creations()).toEqual([]);
  });

  it("« Créer quand même » envoie `force` — une double journée existe", async () => {
    const { dlg, date } = await ouvreCreation();
    date("2026-10-15");
    await souffle();
    fireEvent.click(dlg.getByRole("button", { name: "Créer quand même" }));
    await souffle();
    expect(creations()[0].corps).toMatchObject({ date: "2026-10-15", force: true });
  });

  it("sur un refus du serveur, recharge la liste : l'avertissement apparaît, rien n'est créé", async () => {
    // La liste affichée est en retard (rencontre importée ou créée entre-temps) : le serveur
    // tranche, et l'écran se met à jour au lieu d'afficher une erreur sans issue.
    refusMemeJour = true;
    const toast = vi.fn();
    const { dlg, date } = await ouvreCreation(toast);
    date("2026-10-22");
    await souffle();
    const avant = lectures().length;
    fireEvent.click(dlg.getByRole("button", { name: "Créer" }));
    await souffle();
    expect(toast).toHaveBeenCalledWith(
      "info",
      "Équipe 1 a déjà une rencontre ce jour-là (se déplace à Massy).",
    );
    expect(lectures().length).toBe(avant + 1);
    expect(dlg.getByRole("status").textContent).toMatch(/se déplace à Massy\./);
  });
});
