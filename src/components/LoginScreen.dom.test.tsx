import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// L'ÉCRAN DE CONNEXION — LE PREMIER QUE VOIT UN NOUVEAU MEMBRE.
//
// Ce que ces tests figent : (1) un échec est ANNONCÉ (role="alert") et relié aux champs, au lieu
// d'apparaître en silence sous le formulaire ; (2) hors réseau, on lit une phrase en français, pas
// « Failed to fetch » ; (3) le champ identifiant ResaMania ouvre un clavier d'e-mail sans
// majuscule ni correcteur — iOS « réparait » les adresses.

vi.mock("@/components/FeatureProvider", () => ({
  useFeatures: () => ({ emailLogin: true, biometry: false }),
}));
vi.mock("@/components/PrivacyNotice", () => ({ PrivacyNotice: () => null }));
vi.mock("@/lib/webauthnClient", () => ({
  loginWithPasskey: vi.fn(),
  passkeySupported: async () => false,
  passkeyAutofillSupported: async () => false,
  hasPasskeyOnDevice: () => false,
}));
import { LoginScreen } from "./LoginScreen";

const reponse = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function remplitEtEnvoie() {
  fireEvent.change(screen.getByLabelText("Identifiant ResaMania (email)"), { target: { value: "jean@exemple.fr" } });
  fireEvent.change(screen.getByLabelText("Mot de passe"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));
}

describe("LoginScreen", () => {
  it("l'identifiant ResaMania ouvre un clavier d'e-mail, sans majuscule ni correcteur", () => {
    render(<LoginScreen onLoggedIn={vi.fn()} />);
    const champ = screen.getByLabelText("Identifiant ResaMania (email)");
    expect(champ.getAttribute("inputmode")).toBe("email");
    expect(champ.getAttribute("autocapitalize")).toBe("none");
    expect(champ.getAttribute("autocorrect")).toBe("off");
    expect(champ.getAttribute("spellcheck")).toBe("false");
  });

  it("un refus du serveur est ANNONCÉ et relié aux champs, avec le message du serveur", async () => {
    fetchMock.mockResolvedValue(reponse({ error: "Identifiants incorrects." }, 401));
    render(<LoginScreen onLoggedIn={vi.fn()} />);
    remplitEtEnvoie();
    const alerte = await screen.findByRole("alert");
    expect(alerte.textContent).toContain("Identifiants incorrects.");
    expect(screen.getByLabelText("Identifiant ResaMania (email)").getAttribute("aria-describedby")).toBe(alerte.id);
    expect(screen.getByLabelText("Mot de passe").getAttribute("aria-describedby")).toBe(alerte.id);
  });

  it("hors réseau : une phrase en français, pas « Failed to fetch »", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LoginScreen onLoggedIn={vi.fn()} />);
    remplitEtEnvoie();
    const alerte = await screen.findByRole("alert");
    expect(alerte.textContent).toContain("Pas de réseau : vérifie ta connexion et réessaie.");
    expect(alerte.textContent).not.toContain("Failed to fetch");
  });

  it("l'information (demande de compte envoyée) est annoncée poliment", async () => {
    fetchMock.mockResolvedValue(reponse({ ok: true }));
    render(<LoginScreen onLoggedIn={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Par email" }));
    fireEvent.click(screen.getByRole("button", { name: "Créer un compte" }));
    fireEvent.change(screen.getByLabelText("Ton email"), { target: { value: "jean@exemple.fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Demander un compte" }));
    expect((await screen.findByRole("status")).textContent).toContain("Demande envoyée");
  });
});
