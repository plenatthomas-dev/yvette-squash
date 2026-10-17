import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// RETIRER UN APPAREIL, RÉVOQUER UNE DÉLÉGATION : DEUX APPUIS, PAS UN.
//
// Les deux actions partaient au premier appui, sans retour possible : un appareil retiré doit
// être réenrôlé depuis l'appareil lui-même, une délégation révoquée coupe tout de suite le droit
// du délégué. Le bouton voisin (« Renommer », « Prolonger ») est à 6 px. On reprend la
// confirmation d'« Abandonner » / « Oui, abandonner » du marqueur libre.

vi.mock("@/components/FeatureProvider", () => ({
  useFeatures: () => ({ directory: false, delegation: true, biometry: true }),
}));
vi.mock("@/lib/directoryCache", () => ({
  accountHolders: (m: unknown[]) => m,
  fetchDirectory: async () => [],
  invalidateDirectory: vi.fn(),
}));
vi.mock("@/lib/pushClient", () => ({
  pushEnabledOnServer: () => false,
  pushSubscriptionState: async () => ({ permission: "unsupported", subscribed: false }),
  pushSupported: () => false,
  requestPush: vi.fn(),
  restoreWantedPush: vi.fn(async () => false),
  unsubscribePush: vi.fn(),
}));
vi.mock("@/lib/onForeground", () => ({ onForeground: () => () => {} }));
vi.mock("@/components/NotifUnblockHelp", () => ({ default: () => null }));
vi.mock("@/lib/webauthnClient", () => ({
  enrollPasskey: vi.fn(),
  passkeySupported: async () => true,
  forgetPasskeyOnDevice: vi.fn(),
  hasPasskeyOnDevice: () => true,
}));
vi.mock("@/lib/sound", () => ({ isSoundEnabled: () => false, setSoundEnabled: vi.fn(), playSuccessJingle: vi.fn() }));
import { SettingsButton } from "./SettingsButton";

const reponse = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as Response;

let appels: { url: string; method: string }[];
beforeEach(() => {
  appels = [];
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      appels.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/auth/webauthn/passkeys")
        return reponse({
          passkeys: [{ id: "pk1", deviceLabel: "iPhone de Jean", createdAt: "2026-09-01", lastUsedAt: null, backedUp: true, deviceType: "multiDevice" }],
        });
      if (url === "/api/delegations" && (init?.method ?? "GET") === "GET")
        return reponse({
          outgoing: [{ id: "del1", delegateId: "u2", delegateName: "Paul", expiresAt: "2026-12-01T10:00:00Z" }],
          incoming: [],
          sessionExpiresAt: null,
        });
      return reponse({ ok: true });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function ouvre() {
  const toast = vi.fn();
  render(
    <SettingsButton myId="u1" nickname={null} listed onProfileSaved={vi.fn()} onDelegationsChanged={vi.fn()} toast={toast} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Paramètres" }));
  return toast;
}

const suppressions = () => appels.filter((a) => a.method === "DELETE").map((a) => a.url);

describe("SettingsButton — retirer un appareil de la connexion biométrique", () => {
  it("le premier appui demande confirmation, sans rien supprimer", async () => {
    ouvre();
    const ligne = (await screen.findByText(/iPhone de Jean/)).closest("li") as HTMLElement;
    fireEvent.click(within(ligne).getByRole("button", { name: "Retirer" }));
    expect(suppressions()).toEqual([]);
    expect(within(ligne).getByRole("button", { name: "Oui, retirer" })).toBeTruthy();
    // « Renommer » s'efface le temps de la question : il n'y a plus qu'oui ou non.
    expect(within(ligne).queryByRole("button", { name: "Renommer" })).toBeNull();
  });

  it("« Non, garder » annule ; « Oui, retirer » supprime, et le dit sans le mot « passkey »", async () => {
    const toast = ouvre();
    const ligne = (await screen.findByText(/iPhone de Jean/)).closest("li") as HTMLElement;
    fireEvent.click(within(ligne).getByRole("button", { name: "Retirer" }));
    fireEvent.click(within(ligne).getByRole("button", { name: "Non, garder" }));
    expect(within(ligne).getByRole("button", { name: "Retirer" })).toBeTruthy();
    expect(suppressions()).toEqual([]);

    fireEvent.click(within(ligne).getByRole("button", { name: "Retirer" }));
    fireEvent.click(within(ligne).getByRole("button", { name: "Oui, retirer" }));
    await waitFor(() => expect(suppressions()).toEqual(["/api/auth/webauthn/passkeys/pk1"]));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("ok", "Appareil retiré de la connexion biométrique."));
  });

  it("aucun libellé visible de la section ne dit « passkey »", async () => {
    ouvre();
    const section = (await screen.findByText(/iPhone de Jean/)).closest("section") as HTMLElement;
    expect(section.textContent?.toLowerCase()).not.toContain("passkey");
    for (const el of section.querySelectorAll("[title]")) {
      expect(el.getAttribute("title")?.toLowerCase()).not.toContain("passkey");
    }
  });
});

describe("SettingsButton — révoquer une délégation", () => {
  it("demande confirmation avant de révoquer", async () => {
    ouvre();
    const ligne = (await screen.findByText("Paul")).closest("li") as HTMLElement;
    fireEvent.click(within(ligne).getByRole("button", { name: "Révoquer" }));
    expect(suppressions()).toEqual([]);
    fireEvent.click(within(ligne).getByRole("button", { name: "Oui, révoquer" }));
    await waitFor(() => expect(suppressions()).toEqual(["/api/delegations/del1"]));
  });

  it("« Non, garder » ramène « Prolonger » et « Révoquer », sans rien révoquer", async () => {
    ouvre();
    const ligne = (await screen.findByText("Paul")).closest("li") as HTMLElement;
    fireEvent.click(within(ligne).getByRole("button", { name: "Révoquer" }));
    fireEvent.click(within(ligne).getByRole("button", { name: "Non, garder" }));
    expect(within(ligne).getByRole("button", { name: "Prolonger" })).toBeTruthy();
    expect(suppressions()).toEqual([]);
  });
});
