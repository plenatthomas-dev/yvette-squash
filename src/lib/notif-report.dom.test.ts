import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// LA MESURE NE DOIT PAS COÛTER UNE ÉCRITURE PAR OUVERTURE. Chaque écriture réveille la base :
// on n'envoie que si l'état a changé, ou une fois par jour pour rester dans la fenêtre.

const etat = vi.hoisted(() => ({ permission: "default" as string, subscribed: false }));

vi.mock("@/lib/pushClient", () => ({
  pushSubscriptionState: async () => ({ permission: etat.permission, subscribed: etat.subscribed }),
}));
vi.mock("@/lib/notif-unblock", () => ({ currentNotifPlatform: () => "android-app" }));

const { reportNotifState } = await import("./notif-report");

let fetchMock: ReturnType<typeof vi.fn>;
const corps = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);

beforeEach(() => {
  localStorage.clear();
  etat.permission = "default";
  etat.subscribed = false;
  fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reportNotifState", () => {
  it("relève l'état de l'appareil sous un identifiant aléatoire stable", async () => {
    await reportNotifState("u1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/push/state");
    const c = corps(0);
    expect(c).toMatchObject({ permission: "default", subscribed: false, platform: "android-app" });
    expect(c.deviceId).toMatch(/^[0-9a-f-]{36}$/);

    etat.permission = "denied";
    await reportNotifState("u1");
    expect(corps(1).deviceId).toBe(c.deviceId);
  });

  it("n'écrit pas deux fois le même état dans la journée…", async () => {
    await reportNotifState("u1");
    await reportNotifState("u1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("…mais réécrit dès que l'état ou le compte change", async () => {
    await reportNotifState("u1");
    etat.permission = "granted";
    etat.subscribed = true;
    await reportNotifState("u1");
    await reportNotifState("u2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("réécrit au bout d'un jour, pour rester dans la fenêtre du tableau de bord", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await reportNotifState("u1");
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    await reportNotifState("u1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retente à la prochaine ouverture si le serveur a refusé", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    await reportNotifState("u1");
    await reportNotifState("u1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ne jette jamais, même réseau coupé", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(reportNotifState("u1")).resolves.toBeUndefined();
  });
});
