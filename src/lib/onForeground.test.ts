import { describe, it, expect, vi } from "vitest";
import { onForeground } from "./onForeground";

// LE GARDE-FOU DE RENDU SERVEUR — et il est ici, dans le projet « node », précisément parce
// qu'il n'y a PAS de DOM. C'est la seule condition dans laquelle la promesse se vérifie :
// sous jsdom, `window` existe toujours et la branche testée est inatteignable. Les autres
// promesses du module, qui ont besoin d'événements, vivent dans `onForeground.dom.test.ts`.
//
// Ce que ça protège : le module est importé par des composants client, que Next rend AUSSI
// côté serveur. Sans ce garde-fou, l'import suffirait à faire échouer le rendu — pas l'usage,
// l'import.

describe("onForeground — hors navigateur", () => {
  it("ne touche à rien et rend une fonction de désabonnement inoffensive", () => {
    expect(typeof window).toBe("undefined"); // sinon le test ne mesure pas ce qu'il croit

    const cb = vi.fn();
    const desabonner = onForeground(cb);

    expect(typeof desabonner).toBe("function");
    expect(() => desabonner()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});
