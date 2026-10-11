import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import InstallAppPrompt from "@/components/InstallAppPrompt";

// DANS L'APPLI ANDROID, PAS DE BANNIÈRE « INSTALLER L'APPLI ».
//
// L'appli Android (TWA, cf. android/README.md) n'est que Chrome en plein écran sur le site : la
// bannière s'y affichait donc comme dans un onglet, et proposait d'installer l'appli à quelqu'un
// qui venait justement de l'ouvrir. Chrome ne signale la TWA que par le référent du PREMIER
// chargement (`android-app://<package>/`) : il faut s'en souvenir pour la session.

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

function referrer(value: string) {
  Object.defineProperty(document, "referrer", { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  referrer("");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
  // jsdom n'implémente pas `matchMedia` : « pas en mode standalone ».
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Laisse passer le délai au bout duquel Android affiche les instructions manuelles. */
async function attend() {
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
}

describe("InstallAppPrompt — l'appli Android", () => {
  it("s'affiche dans Chrome Android, hors appli", async () => {
    const { container } = render(<InstallAppPrompt />);
    await attend();
    expect(container.querySelector(".install-banner")).not.toBeNull();
  });

  it("ne s'affiche pas quand l'appli Android vient de lancer la page", async () => {
    referrer("android-app://fr.squashyvette.app/");
    const { container } = render(<InstallAppPrompt />);
    await attend();
    expect(container.querySelector(".install-banner")).toBeNull();
  });

  it("ne revient pas après un rechargement dans l'appli, où le référent a disparu", async () => {
    referrer("android-app://fr.squashyvette.app/");
    render(<InstallAppPrompt />).unmount();

    referrer("https://squash-yvette.vercel.app/");
    const { container } = render(<InstallAppPrompt />);
    await attend();
    expect(container.querySelector(".install-banner")).toBeNull();
  });
});
