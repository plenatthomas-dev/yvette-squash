import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

// L'ABONNEMENT FANTÔME, PAR L'AUTRE BOUT.
//
// L'en-tête d'`InterclubFollow` raconte le défaut qu'il a corrigé : « l'écran qui promettait
// "Détaillé" à un compte dont la base ne contenait aucune ligne ». Il se reproduisait pourtant
// à l'identique par un chemin que ce récit ne couvrait pas.
//
// `ensurePushSubscribed` JETTE — `serviceWorker.register`, `pushManager.subscribe`
// (`InvalidStateError` sur un abonnement posé avec une autre clé VAPID, refus du système), et
// le `fetch` qu'elle termine. Appelée hors du `try`, elle emportait toute la fonction : le PUT
// ne partait jamais, aucun toast, aucun état changé — donc aucun rendu, et le `<select>`
// gardait visuellement le niveau choisi. Le membre repartait convaincu d'être abonné.
//
// Ce que ce fichier verrouille : un échec de la PERMISSION n'emporte pas l'ÉCRITURE. Ce sont
// deux choses distinctes, et l'abonnement vaut d'être enregistré même quand la notification ne
// peut pas encore arriver — c'est le parti pris que le composant défend partout ailleurs.

const ensurePushSubscribed = vi.fn();
const pushSubscriptionState = vi.fn();

vi.mock("@/lib/pushClient", () => ({
  ensurePushSubscribed: () => ensurePushSubscribed(),
  pushSubscriptionState: () => pushSubscriptionState(),
  pushSupported: () => true,
  pushEnabledOnServer: () => true,
}));

const InterclubFollow = (await import("@/components/InterclubFollow")).default;

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];
/** Les abonnements que renvoie le GET — vides sauf mention contraire. */
let suivis: { teamId: string; level: string }[] = [];

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const toast = vi.fn();

function monte() {
  return render(
    <InterclubFollow
      teams={[{ id: "t1", name: "Équipe 1" }]}
      toast={toast}
      onExpired={(status) => status === 401}
    />,
  );
}

beforeEach(() => {
  envois = [];
  suivis = [];
  toast.mockClear();
  ensurePushSubscribed.mockReset();
  // Par défaut l'appareil est DÉJÀ abonné : les cas « rien d'activé » le disent eux-mêmes.
  pushSubscriptionState.mockReset();
  pushSubscriptionState.mockResolvedValue({ permission: "granted", subscribed: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      envois.push({
        url: String(url),
        methode: init?.method ?? "GET",
        corps: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return reponse({ follows: suivis, pushReady: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ecritures = () => envois.filter((e) => e.methode === "PUT");

describe("InterclubFollow — la permission et l'écriture sont deux choses", () => {
  it("enregistre l'abonnement même quand la demande de permission JETTE", async () => {
    ensurePushSubscribed.mockRejectedValue(new Error("InvalidStateError"));

    const { getByRole } = monte();
    await souffle();

    fireEvent.change(getByRole("combobox"), { target: { value: "highlights" } });
    await souffle();

    // L'écriture est partie, malgré l'exception.
    expect(ecritures()).toHaveLength(1);
    expect(ecritures()[0].corps).toEqual({ teamId: "t1", level: "highlights" });
  });

  it("le dit, plutôt que de laisser croire à un abonnement muet", async () => {
    ensurePushSubscribed.mockRejectedValue(new Error("InvalidStateError"));

    const { getByRole } = monte();
    await souffle();
    fireEvent.change(getByRole("combobox"), { target: { value: "detailed" } });
    await souffle();

    // Un seul toast, et il porte la RÉSERVE — c'est le second défaut de cette fonction : `block`
    // était lu depuis le rendu courant, donc aveugle au refus que l'interaction venait
    // elle-même de découvrir, et elle annonçait « Abonnement enregistré » tout court.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][1]).toMatch(/ne peuvent pas encore arriver/);
  });

  it("et quand la permission est accordée, ne met aucune réserve", async () => {
    ensurePushSubscribed.mockResolvedValue(true);

    const { getByRole } = monte();
    await souffle();
    fireEvent.change(getByRole("combobox"), { target: { value: "result" } });
    await souffle();

    expect(ecritures()).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith("ok", "Abonnement enregistré");
  });
});

// Choisir un niveau abonne l'appareil s'il ne l'était pas — c'était déjà le cas, mais en
// silence : le membre ignorait avoir activé quoi que ce soit, et où revenir dessus.
describe("InterclubFollow — l'appareil qui n'était pas abonné", () => {
  it("dit que le choix vient d'activer les notifications, et où les couper", async () => {
    pushSubscriptionState.mockResolvedValue({ permission: "default", subscribed: false });
    ensurePushSubscribed.mockResolvedValue(true);

    const { getByRole } = monte();
    await souffle();
    fireEvent.change(getByRole("combobox"), { target: { value: "result" } });
    await souffle();

    expect(ensurePushSubscribed).toHaveBeenCalledTimes(1);
    expect(ecritures()).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe("ok");
    expect(toast.mock.calls[0][1]).toMatch(/notifications activées.*Paramètres/);
  });

  it("ne signale rien à qui ne suit aucune équipe", async () => {
    pushSubscriptionState.mockResolvedValue({ permission: "default", subscribed: false });

    const { queryByRole } = monte();
    await souffle();

    expect(queryByRole("status")).toBeNull();
  });

  it("signale l'abonnement d'équipe qui n'arrive pas ici, et l'active d'un geste", async () => {
    // « Ne plus recevoir » pressé dans les Paramètres après coup : la ligne existe, l'appareil
    // n'est plus abonné, et le sélecteur affiche toujours le niveau choisi.
    suivis = [{ teamId: "t1", level: "result" }];
    pushSubscriptionState.mockResolvedValue({ permission: "granted", subscribed: false });
    ensurePushSubscribed.mockResolvedValue(true);

    const { getByRole, queryByRole } = monte();
    await souffle();

    expect(getByRole("status").textContent).toMatch(/ne reçoit pas les notifications/);
    fireEvent.click(getByRole("button", { name: "Activer ici" }));
    await souffle();

    expect(ensurePushSubscribed).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][1]).toMatch(/Paramètres/);
    expect(queryByRole("status")).toBeNull();
    // Aucune écriture : on a réparé l'appareil, pas l'abonnement d'équipe, qui était juste.
    expect(ecritures()).toHaveLength(0);
  });

  it("dit le blocage du navigateur dès le chargement, à qui suit une équipe", async () => {
    suivis = [{ teamId: "t1", level: "result" }];
    pushSubscriptionState.mockResolvedValue({ permission: "denied", subscribed: false });

    const { getByRole, queryByRole } = monte();
    await souffle();

    expect(getByRole("status").textContent).toMatch(/bloquées/);
    expect(queryByRole("button", { name: "Activer ici" })).toBeNull();
  });
});
