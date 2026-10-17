import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import InstallAppPrompt from "@/components/InstallAppPrompt";

// SUR ANDROID, PAS DE BANNIÈRE « INSTALLER L'APPLI » (LA PWA).
//
// AndroidAppPrompt y propose l'appli Android (l'APK) à la place. Proposer aussi la PWA ferait
// deux offres concurrentes, et la PWA installée garderait ensuite les notifications de l'appli.
// La mini-barre d'installation de Chrome, qui proposerait la PWA, reste donc retenue.
// Sur ordinateur, rien ne change : la bannière suit `beforeinstallprompt`.

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

/** Chrome signale que la PWA peut s'installer. */
function beforeInstallPrompt() {
  const e = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(e, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: "dismissed" }) });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  // jsdom n'implémente pas `matchMedia` : « pas en mode standalone ».
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("InstallAppPrompt — Android", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
  });

  it("ne propose pas la PWA, même quand Chrome la dit installable", async () => {
    const { container } = render(<InstallAppPrompt />);
    beforeInstallPrompt();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(container.querySelector(".install-banner")).toBeNull();
  });

  it("retient la mini-barre d'installation de Chrome", () => {
    render(<InstallAppPrompt />);
    expect(beforeInstallPrompt().defaultPrevented).toBe(true);
  });
});

describe("InstallAppPrompt — ordinateur", () => {
  it("propose l'installation quand Chrome la dit possible", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(DESKTOP_UA);
    const { container } = render(<InstallAppPrompt />);
    expect(container.querySelector(".install-banner")).toBeNull();
    beforeInstallPrompt();
    expect(container.querySelector(".install-banner")).not.toBeNull();
  });
});

// ============================================================================
//  AU CLAVIER, « PLUS TARD » NE DOIT PAS INSTALLER L'APPLI
// ============================================================================
//
// Le conteneur écoutait Entrée/Espace : la touche REMONTÉE du bouton « Plus tard » y était
// interceptée (`preventDefault` — le clic du bouton n'avait donc jamais lieu) et lançait
// l'installation. Le conteneur n'écoute plus le clavier ; le clic souris reste.
describe("InstallAppPrompt — clavier", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(DESKTOP_UA);
  });

  function promptEspion() {
    const prompt = vi.fn(() => Promise.resolve());
    const e = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(e, { prompt, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    act(() => {
      window.dispatchEvent(e);
    });
    return prompt;
  }

  it("Entrée sur « Plus tard » ne lance pas l'installation", () => {
    const { getByRole } = render(<InstallAppPrompt />);
    const prompt = promptEspion();
    fireEvent.keyDown(getByRole("button", { name: "Plus tard" }), { key: "Enter" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("la bannière n'est plus un « bouton » qui contient des boutons", () => {
    const { container } = render(<InstallAppPrompt />);
    promptEspion();
    const banniere = container.querySelector(".install-banner") as HTMLElement;
    expect(banniere.getAttribute("role")).toBe("status");
    expect(banniere.hasAttribute("tabindex")).toBe(false);
  });

  it("« Plus tard » masque la bannière ; « Installer » ouvre la popup native", async () => {
    const { getByRole, container } = render(<InstallAppPrompt />);
    const prompt = promptEspion();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Installer" }));
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".install-banner")).toBeNull();
  });
});
