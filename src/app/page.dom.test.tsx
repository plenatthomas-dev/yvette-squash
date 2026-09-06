import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/FeatureProvider", () => ({ useFeatures: () => ({ delegation: true }), useFeaturesReady: () => true }));
vi.mock("@/components/SettingsButton", () => ({ SettingsButton: () => null }));
vi.mock("@/components/PasskeyEnrollPrompt", () => ({ PasskeyEnrollPrompt: () => null }));
vi.mock("@/components/PrivacyNotice", () => ({ PrivacyNotice: () => null, InfoIcon: () => null }));
vi.mock("@/components/HeaderMenu", () => ({ HeaderMenu: () => null }));
vi.mock("@/components/AnnouncementBanner", () => ({ recheckBanner: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ reportMaintenance: vi.fn() }));
vi.mock("@/lib/sound", () => ({ unlockAudio: vi.fn(), playSuccessJingle: vi.fn(), playError: vi.fn(), playAlert: vi.fn() }));
vi.mock("@/lib/pushClient", () => ({
  ensurePushSubscribed: vi.fn(), syncPushSubscription: vi.fn(), pushSupported: () => false, pushEnabledOnServer: () => false,
}));
vi.mock("@/components/PlanningGrid", () => ({ PlanningGrid: ({ planning, onBook, onCancelMine }: {
  planning: PlanningDay; onBook: (s: Slot) => void; onCancelMine: (s: Slot) => void;
}) => <div data-testid="planning">{planning.date}
  {planning.slots.map((slot) => <button key={slot.id} onClick={() => slot.mine ? onCancelMine(slot) : onBook(slot)}>{slot.mine ? "Annuler la mienne" : "Réserver le libre"}</button>)}
</div> }));
vi.mock("@/components/WeekGrid", () => ({ WeekGrid: ({ days }: { days: { date: string }[] }) => <div data-testid="week">{days.map((d) => d.date).join(",")}</div> }));
import Home from "./page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const day = (date: string) => ({ date, courts: [], slots: [
  { id: "mine", courtName: "Squash 1", startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T18:45:00.000Z`, mine: true },
  { id: "free", courtName: "Squash 2", startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T18:45:00.000Z`, mine: false },
] });
let planningReplies: Map<string, Promise<Response>>;
let weekReplies: Map<string, Promise<Response>>;
let journalReplies: Map<string, Promise<Response>>;
let calls: { url: string; body?: Record<string, unknown> }[];

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/?date=2026-09-10&view=day");
  planningReplies = new Map(); weekReplies = new Map(); journalReplies = new Map(); calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const date = new URL(url, "http://localhost").searchParams.get("date")!;
    if (url === "/api/auth/me") return response({ id: "me", displayName: "Alice", canBook: true });
    if (url === "/api/delegations") return response({ incoming: [{ delegatorId: "bob", delegatorName: "Bob", expiresAt: "2027-01-01" }] });
    if (url.startsWith("/api/planning?")) return planningReplies.get(date) ?? response(day(date));
    if (url.startsWith("/api/week?")) return weekReplies.get(date) ?? response([{ date, planning: day(date) }]);
    if (url.startsWith("/api/bookings?")) return journalReplies.get(date) ?? response([]);
    if (url.startsWith("/api/alerts/counts")) return response({});
    if (url.startsWith("/api/notifications")) return response({ notifications: [], unread: 0 });
    if (url === "/api/alerts") return response([]);
    return response({ ok: true });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("ouvre la date explicite d'une notification, sans passer par un autre jour", async () => {
  render(<Home />);
  await waitFor(() => expect(screen.getByTestId("planning").textContent).toContain("2026-09-10"));
  expect(calls.filter((c) => c.url.startsWith("/api/planning?")).map((c) => c.url)).toEqual(["/api/planning?date=2026-09-10"]);
});

it.each(["2026-02-31", "invalid"])("ignore une date de lien invalide (%s)", async (date) => {
  window.history.replaceState(null, "", `/?date=${date}`);
  render(<Home />);
  await waitFor(() => expect(screen.getByTestId("planning")).toBeTruthy());
  expect(calls.some((c) => c.url === `/api/planning?date=${date}`)).toBe(false);
});

it.each([200, 401, 500])("ignore une réponse de jour arrivée en retard, erreurs périmées comprises (%s)", async (status) => {
  const old = deferred<Response>(); planningReplies.set("2026-09-10", old.promise);
  render(<Home />);
  await waitFor(() => expect(calls.some((c) => c.url === "/api/planning?date=2026-09-10")).toBe(true));
  fireEvent.click(await screen.findByLabelText("Jour suivant"));
  await waitFor(() => expect(screen.getByTestId("planning").textContent).toContain("2026-09-11"));
  await act(async () => old.resolve(response(status === 200 ? day("2026-09-10") : { error: "Échec périmé" }, status)));
  expect(screen.getByTestId("planning").textContent).toContain("2026-09-11");
  expect(screen.queryByText(/Échec périmé/)).toBeNull();
  expect(calls.some((c) => c.url === "/api/bookings?date=2026-09-10")).toBe(false);
});

it("ignore un journal qui répond pour la date précédente", async () => {
  const old = deferred<Response>(); journalReplies.set("2026-09-10", old.promise);
  render(<Home />);
  await waitFor(() => expect(screen.getByTestId("planning")).toBeTruthy());
  fireEvent.click(await screen.findByLabelText("Jour suivant"));
  await waitFor(() => expect(screen.getByTestId("planning").textContent).toContain("2026-09-11"));
  await act(async () => old.resolve(response([{ id: "old", displayName: "Joueur périmé", startsAt: "2026-09-10T18:00:00Z", status: "booked" }])));
  expect(screen.queryByText(/Joueur périmé/)).toBeNull();
});

it("ignore une réponse de semaine après le passage à la suivante", async () => {
  window.history.replaceState(null, "", "/?date=2026-09-10&view=week");
  const old = deferred<Response>(); weekReplies.set("2026-09-10", old.promise);
  render(<Home />);
  fireEvent.click(await screen.findByRole("button", { name: "Semaine" }));
  await waitFor(() => expect(calls.some((c) => c.url === "/api/week?date=2026-09-10")).toBe(true));
  fireEvent.click(screen.getByLabelText("Semaine suivante"));
  await waitFor(() => expect(screen.getByTestId("week").textContent).toContain("2026-09-17"));
  await act(async () => old.resolve(response([{ date: "2026-09-10", planning: day("2026-09-10") }])));
  expect(screen.getByTestId("week").textContent).toContain("2026-09-17");
});

it("laisse réserver pour Bob alors qu'Alice joue déjà à cet horaire", async () => {
  render(<Home />);
  await waitFor(() => expect(screen.getByTestId("planning")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("R\u00e9server pour"), { target: { value: "bob" } });
  fireEvent.click(screen.getByText("Réserver le libre"));
  fireEvent.click(await screen.findByRole("button", { name: "R\u00e9server" }));
  await waitFor(() => expect(calls.find((c) => c.url === "/api/book")?.body).toMatchObject({ classEventId: "free", onBehalfOf: "bob" }));
});

it("annule la résa d'Alice depuis la grille, même quand le sélecteur affiche Bob", async () => {
  render(<Home />);
  await waitFor(() => expect(screen.getByTestId("planning")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("R\u00e9server pour"), { target: { value: "bob" } });
  fireEvent.click(screen.getByText("Annuler la mienne"));
  fireEvent.click(await screen.findByRole("button", { name: "Annuler la r\u00e9sa" }));
  await waitFor(() => expect(calls.find((c) => c.url === "/api/cancel-slot")?.body).toEqual({ classEventId: "mine" }));
});
