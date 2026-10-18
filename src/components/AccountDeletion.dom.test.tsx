import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Features } from "@/lib/features";

// La page /suppression-compte est celle que Google Play référence. Deux choses comptent :
//   * la demande doit être POSSIBLE dans les deux cas — connecté (un bouton) ou non (une
//     adresse) — et ne partir qu'après une confirmation explicite ;
//   * ce qu'elle annonce doit suivre les flags, comme la note de confidentialité : pas de
//     conservation tue, pas de suppression promise pour une fonction qui n'existe pas.

const flags = vi.hoisted(() => ({ valeurs: {} as Features }));
vi.mock("@/components/FeatureProvider", () => ({ useFeatures: () => flags.valeurs }));
vi.mock("@/components/PrivacyContent", () => ({
  CONTROLLER: "Thomas Plenat",
  CONTACT_EMAIL: "contact@example.fr",
}));

import { AccountDeletion } from "@/components/AccountDeletion";

const TOUT_OFF: Features = {
  tricount: false,
  emailLogin: false,
  biometry: false,
  directory: false,
  delegation: false,
  tournament: false,
  ranking: false,
  rankingHistory: false,
  externalBookings: false,
  interclub: false,
  forum: false,
  scorer: false,
};

const fetchMock = vi.fn();

/** `/api/auth/me` répond `me` (null = 401), la demande répond `demande`. */
function serveur(me: { displayName: string } | null, demande = { status: 200, body: { ok: true } }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/auth/me") {
      return me
        ? new Response(JSON.stringify(me), { status: 200 })
        : new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401 });
    }
    return new Response(JSON.stringify(demande.body), { status: demande.status });
  });
}

const texte = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  flags.valeurs = { ...TOUT_OFF };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("faire la demande", () => {
  it("sans connexion : pas de bouton, mais l'adresse, avec un objet pré-rempli", async () => {
    serveur(null);
    render(<AccountDeletion />);
    await screen.findByText(/Personne n'est connecté/);
    expect(screen.queryByRole("button", { name: /Demander la suppression/ })).toBeNull();
    const lien = screen.getByRole("link", { name: "contact@example.fr" });
    expect(lien.getAttribute("href")).toMatch(/^mailto:contact@example\.fr\?subject=Suppression/);
  });

  it("connecté : rien ne part avant la confirmation", async () => {
    serveur({ displayName: "Alice Martin" });
    render(<AccountDeletion />);
    fireEvent.click(await screen.findByRole("button", { name: /Demander la suppression/ }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/account/deletion-request", expect.anything());
    expect(screen.getByText(/Alice Martin/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirmer la demande/ }));
    await screen.findByText(/Demande envoyée/);
    expect(fetchMock).toHaveBeenCalledWith("/api/account/deletion-request", { method: "POST" });
  });

  it("annuler revient au bouton, sans rien envoyer", async () => {
    serveur({ displayName: "Alice" });
    render(<AccountDeletion />);
    fireEvent.click(await screen.findByRole("button", { name: /Demander la suppression/ }));
    fireEvent.click(screen.getByRole("button", { name: /Annuler/ }));
    expect(screen.getByRole("button", { name: /Demander la suppression/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1); // seulement /api/auth/me
  });

  it("un refus du serveur s'affiche, et la confirmation reste disponible", async () => {
    serveur({ displayName: "Alice" }, { status: 429, body: { error: "Limite atteinte" } } as never);
    render(<AccountDeletion />);
    fireEvent.click(await screen.findByRole("button", { name: /Demander la suppression/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmer la demande/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Limite atteinte/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirmer la demande/ })).toHaveProperty("disabled", false),
    );
  });
});

describe("ce qu'elle annonce suit les flags", () => {
  it("toutes fonctions coupées : ni interclub, ni tournoi, ni Frais", async () => {
    serveur(null);
    render(<AccountDeletion />);
    await screen.findByText(/Personne n'est connecté/);
    const t = texte();
    expect(t).not.toMatch(/interclub/i);
    expect(t).not.toMatch(/tournoi/i);
    expect(t).not.toMatch(/Frais/);
    // Le délai, lui, est toujours annoncé : c'est ce que Google demande de dire.
    expect(t).toMatch(/un mois au plus/);
    expect(t).toMatch(/ResaMania/);
  });

  it("annonce les deux conservations que la note de confidentialité annonce aussi", async () => {
    flags.valeurs = { ...TOUT_OFF, interclub: true, tournament: true };
    serveur(null);
    render(<AccountDeletion />);
    await screen.findByText(/Personne n'est connecté/);
    const t = texte();
    expect(t).toMatch(/feuilles de match interclub/);
    expect(t).toMatch(/tableau des tournois/);
  });

  it("prévient que des dépenses partagées retardent la suppression", async () => {
    flags.valeurs = { ...TOUT_OFF, tricount: true };
    serveur(null);
    render(<AccountDeletion />);
    await screen.findByText(/Personne n'est connecté/);
    expect(texte()).toMatch(/ton compte est désactivé/);
  });
});
