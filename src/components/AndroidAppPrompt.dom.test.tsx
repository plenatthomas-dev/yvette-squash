import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import AndroidAppPrompt, { APK_URL } from "@/components/AndroidAppPrompt";

// SUR ANDROID, ON PROPOSE L'APPLI ANDROID (L'APK), PAS LA PWA.
//
// Dans un onglet (arrivé par le QR code) comme dans la PWA déjà installée. Seule l'appli
// Android elle-même n'affiche rien : elle tourne en `display-mode: standalone` comme la PWA, et
// seul le référent du premier chargement (`android-app://fr.squashyvette.app/`) l'en distingue.
// Dans la PWA, la bannière demande en plus de la supprimer, sinon elle garde les notifications.

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const INSTALLED = [{ platform: "play", id: "fr.squashyvette.app" }];

function referrer(value: string) {
  Object.defineProperty(document, "referrer", { value, configurable: true });
}

function standalone(yes: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: yes && q === "(display-mode: standalone)",
    media: q,
  }));
}

function relatedApps(apps: { platform: string; id?: string }[]) {
  Object.defineProperty(navigator, "getInstalledRelatedApps", {
    value: () => Promise.resolve(apps),
    configurable: true,
  });
}

/** Rend la bannière et laisse répondre `getInstalledRelatedApps`. */
async function affiche() {
  const r = render(<AndroidAppPrompt />);
  await act(async () => {});
  return r.container;
}

const lien = (c: HTMLElement) => c.querySelector("a[role=button]");

// jsdom ne sait pas naviguer : on bloque la navigation du lien, pas le clic.
const noNavigation = (e: Event) => e.preventDefault();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  referrer("");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
  standalone(false);
  relatedApps([]);
  document.addEventListener("click", noNavigation);
});

afterEach(() => {
  document.removeEventListener("click", noNavigation);
  delete (navigator as { getInstalledRelatedApps?: unknown }).getInstalledRelatedApps;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AndroidAppPrompt — dans un onglet de Chrome Android", () => {
  it("propose l'APK", async () => {
    const c = await affiche();
    expect(lien(c)?.getAttribute("href")).toBe(APK_URL);
  });

  it("explique l'installation une fois le lien touché, sans parler de PWA à supprimer", async () => {
    const c = await affiche();
    fireEvent.click(lien(c)!);
    expect(lien(c)).toBeNull();
    expect(c.textContent).toContain("squash-yvette.apk");
    expect(c.textContent).not.toContain("Désinstaller");
  });

  it("ne s'affiche pas quand l'appli est déjà installée", async () => {
    relatedApps(INSTALLED);
    const c = await affiche();
    expect(c.querySelector(".install-banner")).toBeNull();
  });

  it("s'affiche quand une autre appli Android a ouvert la page (lien Gmail)", async () => {
    referrer("android-app://com.google.android.gm/");
    const c = await affiche();
    expect(lien(c)).not.toBeNull();
  });
});

describe("AndroidAppPrompt — dans la PWA installée sur Android", () => {
  beforeEach(() => standalone(true));

  it("propose l'APK", async () => {
    const c = await affiche();
    expect(lien(c)?.getAttribute("href")).toBe(APK_URL);
  });

  it("demande de supprimer la PWA une fois le lien touché", async () => {
    const c = await affiche();
    fireEvent.click(lien(c)!);
    expect(c.textContent).toContain("squash-yvette.apk");
    expect(c.textContent).toContain("Désinstaller");
  });

  it("demande seulement de supprimer la PWA quand l'appli est déjà installée", async () => {
    relatedApps(INSTALLED);
    const c = await affiche();
    expect(c.textContent).toContain("L'appli Android est installée");
    expect(lien(c)).toBeNull();
  });

  it("propose l'APK quand Chrome ne sait pas dire si l'appli est installée", async () => {
    delete (navigator as { getInstalledRelatedApps?: unknown }).getInstalledRelatedApps;
    const c = await affiche();
    expect(lien(c)).not.toBeNull();
  });
});

describe("AndroidAppPrompt — ailleurs", () => {
  it("ne s'affiche pas dans l'appli Android", async () => {
    standalone(true);
    referrer("android-app://fr.squashyvette.app/");
    const c = await affiche();
    expect(c.querySelector(".install-banner")).toBeNull();
  });

  it("ne revient pas après un rechargement dans l'appli, où le référent a disparu", async () => {
    standalone(true);
    referrer("android-app://fr.squashyvette.app/");
    render(<AndroidAppPrompt />).unmount();

    referrer("https://squash-yvette.vercel.app/");
    const c = await affiche();
    expect(c.querySelector(".install-banner")).toBeNull();
  });

  it("ne s'affiche pas sur iPhone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    const c = await affiche();
    expect(c.querySelector(".install-banner")).toBeNull();
  });

  it("« Plus tard » la masque, y compris au chargement suivant", async () => {
    const r = render(<AndroidAppPrompt />);
    await act(async () => {});
    fireEvent.click(r.getByText("Plus tard"));
    expect(r.container.querySelector(".install-banner")).toBeNull();
    r.unmount();

    const c = await affiche();
    expect(c.querySelector(".install-banner")).toBeNull();
  });
});
