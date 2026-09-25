import { describe, it, expect, vi, afterEach } from "vitest";
import { clearSystemNotifications } from "./pushClient";

// LA PASTILLE DE L'ICÔNE compte les notifications SYSTÈME, pas la cloche : vider la cloche
// laissait « 18 » sur l'icône Android. Ce qu'on vérifie ici, c'est que chaque notification
// affichée est fermée, et qu'aucune absence d'API ne fait jeter.

function installer(sw: unknown, clearAppBadge?: () => Promise<void>) {
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  Object.defineProperty(navigator, "clearAppBadge", { value: clearAppBadge, configurable: true });
}

afterEach(() => {
  // @ts-expect-error nettoyage des propriétés posées par le test
  delete navigator.serviceWorker;
  // @ts-expect-error idem
  delete navigator.clearAppBadge;
});

describe("clearSystemNotifications", () => {
  it("ferme chaque notification affichée et efface la pastille", async () => {
    const notifs = [{ close: vi.fn() }, { close: vi.fn() }];
    const clearAppBadge = vi.fn(async () => {});
    installer({ getRegistration: vi.fn(async () => ({ getNotifications: async () => notifs })) }, clearAppBadge);

    await clearSystemNotifications();

    expect(notifs[0].close).toHaveBeenCalledOnce();
    expect(notifs[1].close).toHaveBeenCalledOnce();
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });

  it("ne jette pas sans service worker enregistré ni API de pastille (Chrome Android)", async () => {
    installer({ getRegistration: vi.fn(async () => undefined) });
    await expect(clearSystemNotifications()).resolves.toBeUndefined();
  });

  it("ne jette pas quand le service worker échoue", async () => {
    installer({ getRegistration: vi.fn(async () => { throw new Error("SecurityError"); }) }, async () => {
      throw new Error("NotAllowedError");
    });
    await expect(clearSystemNotifications()).resolves.toBeUndefined();
  });
});
