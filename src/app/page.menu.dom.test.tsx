import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// CE QUE CE FICHIER GARDE.
//
// Le menu ⋯ a DEUX façons de traiter une fonction coupée, et elles ne sont pas
// interchangeables :
//
//   1. GRISÉE « 🚧 » — Frais, Tournois, Interclub, Annuaire. La fonction existe et arrive :
//      l'entrée grisée est une annonce datée.
//   2. ABSENTE — Capitaine, LE FIL et PROGRESSION. Rien à annoncer : montrer une porte close
//      à chaque ouverture du menu n'informe personne et n'appelle qu'un clic sans effet.
//
// Le fil puis Progression sont passés de (1) à (2) : ce fichier empêche qu'un copier-coller
// de l'entrée voisine les fasse revenir en arrière sans qu'on s'en aperçoive.

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/SettingsButton", () => ({ SettingsButton: () => null }));
vi.mock("@/components/PasskeyEnrollPrompt", () => ({ PasskeyEnrollPrompt: () => null }));
vi.mock("@/components/PrivacyNotice", () => ({ PrivacyNotice: () => null, InfoIcon: () => null }));
vi.mock("@/components/AnnouncementBanner", () => ({ recheckBanner: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ reportMaintenance: vi.fn() }));
vi.mock("@/lib/sound", () => ({ unlockAudio: vi.fn(), playSuccessJingle: vi.fn(), playError: vi.fn(), playAlert: vi.fn() }));
vi.mock("@/lib/pushClient", () => ({
  ensurePushSubscribed: vi.fn(), syncPushSubscription: vi.fn(), pushSupported: () => false, pushEnabledOnServer: () => false,
}));
vi.mock("@/components/PlanningGrid", () => ({ PlanningGrid: () => <div data-testid="planning" /> }));
vi.mock("@/components/WeekGrid", () => ({ WeekGrid: () => null }));

/**
 * Le vrai `HeaderMenu` cache ses entrées derrière un bouton ⋯ ; on le remplace par un rendu
 * plat qui expose CE QUE LA PAGE LUI A PASSÉ — la seule chose en jeu ici. `comingSoon` est
 * rendu en attribut pour distinguer « absente » de « présente mais grisée ».
 */
type Item = { key: string; label: string; disabled?: boolean; comingSoon?: boolean };
vi.mock("@/components/HeaderMenu", () => ({
  HeaderMenu: ({ items }: { items: Item[] }) => (
    <div data-testid="menu">
      {items.map((it) => (
        <span key={it.key} data-testid={`item-${it.key}`} data-soon={it.comingSoon ? "1" : "0"}>
          {it.label}
        </span>
      ))}
    </div>
  ),
}));

// Les flags que la page lira, réglés par chaque test avant le rendu.
const h = vi.hoisted(() => ({ features: {} as Record<string, boolean> }));
vi.mock("@/components/FeatureProvider", () => ({
  useFeatures: () => h.features,
  useFeaturesReady: () => true,
}));

import Home from "./page";

const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/?date=2026-09-10&view=day");
  h.features = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") return response({ id: "me", displayName: "Alice", canBook: true });
    if (url === "/api/delegations") return response({ incoming: [] });
    if (url.startsWith("/api/planning?")) return response({ date: "2026-09-10", courts: [], slots: [] });
    if (url.startsWith("/api/week?")) return response([]);
    if (url.startsWith("/api/bookings?")) return response([]);
    if (url.startsWith("/api/notifications")) return response({ notifications: [], unread: 0 });
    return response({});
  }));
});
afterEach(() => vi.unstubAllGlobals());

const menu = async () => {
  render(<Home />);
  return waitFor(() => screen.getByTestId("menu"));
};

describe("le menu ⋯ face à une fonction coupée", () => {
  it("N'AFFICHE RIEN pour Le fil quand le forum est coupé", async () => {
    await menu();
    expect(screen.queryByTestId("item-forum")).toBeNull();
    expect(screen.queryByText("Le fil")).toBeNull();
  });

  it("affiche Le fil, non grisé, quand le forum est allumé", async () => {
    h.features = { forum: true };
    await menu();
    const item = await screen.findByTestId("item-forum");
    expect(item.textContent).toBe("Le fil");
    expect(item.dataset.soon).toBe("0");
  });

  it("N'AFFICHE RIEN pour Progression quand elle est coupée", async () => {
    await menu();
    expect(screen.queryByTestId("item-rankhist")).toBeNull();
    expect(screen.queryByText("Progression")).toBeNull();
  });

  it("affiche Progression, non grisée, quand ses DEUX interrupteurs sont allumés", async () => {
    h.features = { ranking: true, rankingHistory: true };
    await menu();
    const item = await screen.findByTestId("item-rankhist");
    expect(item.textContent).toBe("Progression");
    expect(item.dataset.soon).toBe("0");
  });

  // `progression` vaut `ranking && rankingHistory` : un seul des deux ne suffit pas, et
  // l'entrée reste ALORS ABSENTE — pas grisée. C'est le cas qu'on casserait en écrivant
  // `...(rankingHistory ? …)` par raccourci.
  it.each([
    ["ranking seul", { ranking: true }],
    ["rankingHistory seul", { rankingHistory: true }],
  ])("garde Progression absente avec %s", async (_nom, features) => {
    h.features = features;
    await menu();
    expect(screen.queryByTestId("item-rankhist")).toBeNull();
  });

  // Le contre-exemple : les entrées voisines gardent bien leur « 🚧 ». Sans lui, masquer
  // TOUTES les entrées coupées passerait ce fichier sans qu'on le remarque.
  it.each([
    ["money", "Frais partagés"],
    ["tourney", "Tournois"],
    ["interclub", "Interclub"],
    ["directory", "Annuaire"],
  ])("laisse %s grisée « en travaux », elle", async (key, label) => {
    await menu();
    const item = await screen.findByTestId(`item-${key}`);
    expect(item.textContent).toBe(label);
    expect(item.dataset.soon).toBe("1");
  });
});
