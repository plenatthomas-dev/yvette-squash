import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// /reinitialiser : l'échec doit être ANNONCÉ (role="alert"), relié au champ, et lisible — ni
// « Failed to fetch » hors réseau, ni « Unexpected end of JSON input » sur un 500 au corps vide.

vi.mock("@/components/FeatureProvider", () => ({ useFeatures: () => ({ emailLogin: true }) }));
vi.mock("@/components/PrivacyNotice", () => ({ PrivacyNotice: () => null }));
import ResetPasswordPage from "./page";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.history.replaceState(null, "", "/reinitialiser?token=abc");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function envoie() {
  render(<ResetPasswordPage />);
  fireEvent.change(await screen.findByLabelText("Nouveau mot de passe"), { target: { value: "motdepasse" } });
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer et me connecter" }));
}

it("un refus du serveur est annoncé et relié au champ", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Lien expiré." }) } as Response);
  await envoie();
  const alerte = await screen.findByRole("alert");
  expect(alerte.textContent).toContain("Lien expiré.");
  expect(screen.getByLabelText("Nouveau mot de passe").getAttribute("aria-describedby")).toBe(alerte.id);
});

it("hors réseau : une phrase en français, pas « Failed to fetch »", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await envoie();
  expect((await screen.findByRole("alert")).textContent).toContain("Pas de réseau");
  expect(screen.queryByText(/Failed to fetch/)).toBeNull();
});
