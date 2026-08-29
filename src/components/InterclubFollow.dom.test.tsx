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

vi.mock("@/lib/pushClient", () => ({
  ensurePushSubscribed: () => ensurePushSubscribed(),
  pushSupported: () => true,
  pushEnabledOnServer: () => true,
}));

const InterclubFollow = (await import("@/components/InterclubFollow")).default;

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];

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
  toast.mockClear();
  ensurePushSubscribed.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      envois.push({
        url: String(url),
        methode: init?.method ?? "GET",
        corps: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return reponse({ follows: [], pushReady: true });
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
