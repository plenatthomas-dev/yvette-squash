import { describe, it, expect, vi } from "vitest";
import { keepAwake } from "./wake-lock";

// ============================================================================
//  « J'AI DÛ DÉVERROUILLER MON TÉLÉPHONE ENTRE CHAQUE ÉCHANGE. »
//
//  Ce qui se teste ici n'est pas « le verrou est posé » — ça, on le voit tout de
//  suite. C'est ce qu'on ne voit PAS : qu'il revienne après un coup de téléphone,
//  et qu'il ne reste pas accroché quand l'écran de marquage se ferme.
//
//  jsdom ne connaît pas l'API : le double est donc obligatoire, et c'est très
//  bien — il permet de rejouer la seule chose que le navigateur fait dans notre
//  dos, relâcher le verrou dès que l'onglet est caché, sans prévenir.
// ============================================================================

/** Un navigateur qui sait tenir l'écran allumé, et qui note ce qu'on lui demande. */
function navigateur() {
  const relaches: Sentinelle[] = [];
  type Sentinelle = { release: () => Promise<void>; released: boolean };
  const posees: Sentinelle[] = [];
  return {
    posees,
    relaches,
    wakeLock: {
      request: vi.fn(async () => {
        const s: Sentinelle = {
          released: false,
          release: async () => {
            s.released = true;
            relaches.push(s);
          },
        };
        posees.push(s);
        return s;
      }),
    },
  };
}

/** Un document dont on pilote la visibilité, comme le système le ferait. */
function document_(visible = true) {
  const auditeurs = new Map<string, (() => void)[]>();
  return {
    visibilityState: visible ? ("visible" as const) : ("hidden" as const),
    addEventListener: (t: string, f: () => void) => {
      auditeurs.set(t, [...(auditeurs.get(t) ?? []), f]);
    },
    removeEventListener: (t: string, f: () => void) => {
      auditeurs.set(t, (auditeurs.get(t) ?? []).filter((g) => g !== f));
    },
    /** Rejoue ce que le système fait : il relâche le verrou, PUIS prévient. */
    bascule(vers: "visible" | "hidden", sentinelles: { released: boolean }[]) {
      this.visibilityState = vers;
      if (vers === "hidden") for (const s of sentinelles) s.released = true;
      for (const f of auditeurs.get("visibilitychange") ?? []) f();
    },
    compte: () => (auditeurs.get("visibilitychange") ?? []).length,
  };
}

const souffle = () => new Promise((r) => setTimeout(r, 0));

describe("keepAwake", () => {
  it("demande le verrou tout de suite", async () => {
    const nav = navigateur();
    keepAwake(nav, document_() as never);
    await souffle();
    expect(nav.wakeLock.request).toHaveBeenCalledWith("screen");
    expect(nav.posees).toHaveLength(1);
  });

  it("⚠️ le REPREND au retour au premier plan", async () => {
    // LA MOITIÉ QU'ON OUBLIE. Le système relâche le verrou dès que l'onglet est caché, sans
    // prévenir : sans cette reprise, il tient pendant le premier jeu — celui où l'on regarde
    // encore l'écran — et lâche pour tous les suivants.
    const nav = navigateur();
    const doc = document_();
    keepAwake(nav, doc as never);
    await souffle();

    doc.bascule("hidden", nav.posees);
    await souffle();
    expect(nav.posees).toHaveLength(1); // caché : on ne redemande pas

    doc.bascule("visible", []);
    await souffle();
    expect(nav.posees).toHaveLength(2);
  });

  it("ne redemande PAS un verrou encore valide", async () => {
    // Un `visibilitychange` peut arriver sans que le verrou soit tombé. En redemander un
    // second laisserait le premier accroché, sans personne pour le relâcher.
    const nav = navigateur();
    const doc = document_();
    keepAwake(nav, doc as never);
    await souffle();
    doc.bascule("visible", []);
    await souffle();
    expect(nav.posees).toHaveLength(1);
  });

  it("relâche tout et se débranche à l'arrêt", async () => {
    const nav = navigateur();
    const doc = document_();
    const arret = keepAwake(nav, doc as never);
    await souffle();
    arret();
    await souffle();
    expect(nav.relaches).toHaveLength(1);
    expect(doc.compte()).toBe(0);
  });

  it("⚠️ relâche un verrou arrivé APRÈS l'arrêt", async () => {
    // La demande est asynchrone. Fermer le marquage pendant qu'elle est en vol laissait un
    // verrou que plus personne ne tient — et l'écran du téléphone restait allumé jusqu'à ce
    // qu'on quitte l'appli.
    const nav = navigateur();
    const arret = keepAwake(nav, document_() as never);
    arret(); // avant que la promesse de `request` ne se résolve
    await souffle();
    expect(nav.posees).toHaveLength(1);
    expect(nav.posees[0].released).toBe(true);
  });

  it("ne jette pas quand le navigateur ne connaît pas l'API", () => {
    // Firefox Android, à ce jour. Le marquage doit fonctionner exactement pareil.
    expect(() => keepAwake({}, document_() as never)()).not.toThrow();
  });

  it("ne jette pas quand le verrou est REFUSÉ", async () => {
    // Batterie faible, réglage système. On n'insiste pas, et on ne dit rien : personne ne doit
    // recevoir un message d'erreur pendant qu'il compte des points.
    const nav = { wakeLock: { request: vi.fn(async () => Promise.reject(new Error("refusé"))) } };
    const arret = keepAwake(nav as never, document_() as never);
    await souffle();
    expect(() => arret()).not.toThrow();
  });

  it("ne jette pas sans document (rendu serveur)", () => {
    expect(() => keepAwake(navigateur(), null)()).not.toThrow();
  });
});
