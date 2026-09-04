import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import Membres from "./page";

// LE NOM DE RECHERCHE SQUASHNET, SAISI À DEUX MAINS.
//
// Ce fichier existe à cause d'un défaut précis, et coûteux : le formulaire était INERTE. Le nom
// ne s'enregistre que si ses DEUX moitiés sont là (une identité amputée rendrait le
// rapprochement plus permissif que le défaut, cf. l'API). Mais on les tape l'une après l'autre,
// et chaque champ se jugeait contre le seul état venu du serveur — lequel ne peut pas avoir
// bougé, puisqu'on n'a encore rien écrit. Résultat : le prénom refusé car le nom manquait, puis
// le nom refusé car le prénom n'avait jamais été envoyé. Rien ne partait, sans un mot à
// l'écran, et le membre restait « introuvable sur squashnet » pour une raison entièrement
// locale — on a d'abord soupçonné la fédération.
//
// D'où trois verrous : les deux moitiés doivent se voir, une saisie à moitié doit le DIRE, et
// une valeur inchangée ne doit toujours rien déclencher.

const fetchMock = vi.fn();

vi.mock("@/components/FeatureProvider", () => ({
  useFeatures: () => ({ emailLogin: true, interclub: true }),
}));

function membre(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    displayName: "Matthieu Soisier", // orthographe ResaMania, fautive — le cas réel
    nickname: null,
    email: "m@ex.com",
    mode: "resamania",
    hasPassword: true,
    verified: true,
    passkeys: [],
    lastLoginAt: null,
    lastSeenAt: null,
    disabledAt: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    teamId: "t1", // rattaché à une équipe : c'est ce qui fait apparaître le bloc squashnet
    clt: null,
    cltOverride: null,
    cltSource: null,
    rangM: null,
    rangMOverride: null,
    rangMSource: null,
    squashnetGivenName: null,
    squashnetFamilyName: null,
    squashnetMatched: false,
    bookingsApp: 0,
    bookingsResa: 0,
    ...over,
  };
}

/** Réponse JSON minimale, façon `fetch`. */
function json(corps: unknown) {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Monte l'écran avec un membre, la liste étant servie par le GET initial. */
async function monte(over: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") {
      return json({ members: [membre(over)], teams: [{ id: "t1", name: "Équipe 1" }] });
    }
    return json({ ok: true, status: "matched" });
  });
  render(<Membres />);
  await souffle();
}

/** Les corps des POST envoyés à l'API, décodés. */
function posts(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((c) => c[1]?.method === "POST")
    .map((c) => JSON.parse(c[1].body as string));
}

const prenom = () => screen.getByLabelText("Prénom sur squashnet de Matthieu Soisier");
const nom = () => screen.getByLabelText("Nom de famille sur squashnet de Matthieu Soisier");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("/admin/membres — nom de recherche squashnet", () => {
  it("enregistre dès que la SECONDE moitié est saisie", async () => {
    // Le cas qui échouait : deux champs remplis l'un après l'autre, chacun validé à la perte
    // de focus. La première moitié ne part pas (normal, elle est seule) ; la seconde DOIT
    // emporter les deux.
    await monte();

    fireEvent.change(prenom(), { target: { value: "Matthieu" } });
    fireEvent.blur(prenom());
    expect(posts()).toEqual([]); // seul le prénom : rien à envoyer

    fireEvent.change(nom(), { target: { value: "Soismier" } });
    await act(async () => {
      fireEvent.blur(nom());
      await souffle();
    });

    expect(posts()).toEqual([
      { id: "u1", action: "set_squashnet_name", givenName: "Matthieu", familyName: "Soismier" },
    ]);
  });

  it("DIT que rien n'est enregistré tant qu'une moitié manque", async () => {
    // Se taire ici, c'est laisser croire à une saisie prise en compte — et faire chercher la
    // panne du côté de la fédération.
    await monte();
    fireEvent.change(nom(), { target: { value: "Soismier" } });
    expect(
      screen.getByText(/rien n'est enregistré tant qu'il en manque un/i),
    ).toBeTruthy();

    fireEvent.change(prenom(), { target: { value: "Matthieu" } });
    expect(screen.queryByText(/rien n'est enregistré tant qu'il en manque un/i)).toBeNull();
  });

  it("normalise les blancs avant d'envoyer", async () => {
    await monte();
    fireEvent.change(prenom(), { target: { value: "  Jean   Pierre " } });
    fireEvent.change(nom(), { target: { value: " Dupont " } });
    await act(async () => {
      fireEvent.blur(nom());
      await souffle();
    });
    expect(posts()[0]).toMatchObject({ givenName: "Jean Pierre", familyName: "Dupont" });
  });

  it("ne renvoie RIEN quand la valeur n'a pas changé", async () => {
    // Quitter un champ qu'on a seulement relu est un geste ordinaire ; il ne doit pas relancer
    // un appel réseau vers la fédération.
    await monte({ squashnetGivenName: "Matthieu", squashnetFamilyName: "Soismier" });
    fireEvent.blur(prenom());
    fireEvent.blur(nom());
    await souffle();
    expect(posts()).toEqual([]);
  });

  it("vider les DEUX champs retire la correction", async () => {
    await monte({ squashnetGivenName: "Matthieu", squashnetFamilyName: "Soismier" });
    fireEvent.change(prenom(), { target: { value: "" } });
    fireEvent.change(nom(), { target: { value: "" } });
    await act(async () => {
      fireEvent.blur(nom());
      await souffle();
    });
    expect(posts()[0]).toMatchObject({ givenName: "", familyName: "" });
  });

  it("« Re-rapprocher » retente sans rien modifier", async () => {
    // Un échec n'accuse pas toujours le nom : squashnet muet, licence pas encore publiée, mois
    // pas encore paru. Ce bouton doit donc partir même quand rien n'a été touché.
    await monte({ squashnetGivenName: "Matthieu", squashnetFamilyName: "Soismier" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Re-rapprocher" }));
      await souffle();
    });
    expect(posts()).toEqual([{ id: "u1", action: "rematch_squashnet" }]);
  });
});
