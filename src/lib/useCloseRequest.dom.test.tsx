import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { useCloseRequest } from "@/lib/useCloseRequest";
import { Dialog } from "@/components/Dialog";

// LE RETOUR D'ANDROID FERME LE PANNEAU, PAS L'APPLI.
//
// jsdom ne connaît pas `CloseWatcher` : on le simule, avec ce que Chrome en garantit — une pile
// d'observateurs dont le PLUS RÉCENT reçoit la demande de fermeture, et qui s'éteint après son
// `close`. `retour()` joue le geste retour d'Android.

class FauxCloseWatcher {
  static pile: FauxCloseWatcher[] = [];
  onclose: (() => void) | null = null;
  constructor() {
    FauxCloseWatcher.pile.push(this);
  }
  destroy() {
    FauxCloseWatcher.pile = FauxCloseWatcher.pile.filter((w) => w !== this);
  }
}

function retour() {
  const w = FauxCloseWatcher.pile.at(-1);
  if (!w) return false;
  act(() => {
    w.destroy();
    w.onclose?.();
  });
  return true;
}

beforeEach(() => {
  FauxCloseWatcher.pile = [];
  vi.stubGlobal("CloseWatcher", FauxCloseWatcher);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Panneau({ onClose, actif = true }: { onClose: () => void; actif?: boolean }) {
  useCloseRequest(onClose, actif);
  return <p>panneau</p>;
}

describe("useCloseRequest", () => {
  it("ferme le panneau au retour", () => {
    const onClose = vi.fn();
    render(<Panneau onClose={onClose} />);
    expect(retour()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("n'écoute rien tant qu'il est inactif", () => {
    render(<Panneau onClose={vi.fn()} actif={false} />);
    expect(FauxCloseWatcher.pile).toHaveLength(0);
  });

  it("se retire quand le panneau se ferme autrement (croix, clic dehors)", () => {
    const { unmount } = render(<Panneau onClose={vi.fn()} />);
    expect(FauxCloseWatcher.pile).toHaveLength(1);
    unmount();
    // Sinon le retour suivant « fermerait » un panneau disparu, et ne fermerait rien de visible.
    expect(FauxCloseWatcher.pile).toHaveLength(0);
  });

  it("se réarme si le panneau refuse de se fermer, au lieu de laisser le retour fermer l'appli", () => {
    const onClose = vi.fn(); // ne ferme rien : un envoi en cours, par exemple
    render(<Panneau onClose={onClose} />);
    retour();
    expect(FauxCloseWatcher.pile).toHaveLength(1);
    retour();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ferme d'abord le dernier panneau ouvert", () => {
    function Deux() {
      const [bas, setBas] = useState(true);
      const [haut, setHaut] = useState(true);
      return (
        <>
          {bas && <Panneau onClose={() => setBas(false)} />}
          {haut && <Panneau onClose={() => setHaut(false)} />}
          <span data-testid="etat">{`${bas}-${haut}`}</span>
        </>
      );
    }
    const { getByTestId } = render(<Deux />);
    retour();
    expect(getByTestId("etat").textContent).toBe("true-false");
    retour();
    expect(getByTestId("etat").textContent).toBe("false-false");
    expect(retour()).toBe(false); // plus rien d'ouvert : le retour revient au système
  });

  it("ne fait rien là où l'API n'existe pas (iOS, Firefox)", () => {
    vi.unstubAllGlobals();
    const onClose = vi.fn();
    expect(() => render(<Panneau onClose={onClose} />)).not.toThrow();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Dialog — le retour d'Android ferme la modale", () => {
  it("ferme toutes les modales construites sur Dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog onClose={onClose} label="Essai">
        <button>ok</button>
      </Dialog>,
    );
    retour();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
