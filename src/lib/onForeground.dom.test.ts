import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onForeground } from "./onForeground";

// LE DÉDOUBLONNAGE DU RETOUR AU PREMIER PLAN, MESURÉ.
//
// `docs/interclub.md` compte ce module parmi les TROIS pièces qui tiennent le coût du direct,
// à côté du cache et de la cadence de sondage. Il n'avait pourtant aucun test : aucun fichier
// n'émettait `focus`, `visibilitychange` ni `pageshow`. `InterclubLive.dom.test.tsx` l'importe
// pour de vrai, mais ne le déclenche jamais — la promesse était donc écrite trois fois (ici,
// dans l'en-tête d'`InterclubLive`, dans la doc) et vérifiée zéro.
//
// L'unité est le NOMBRE D'APPELS, comme ailleurs sur cet écran : c'est en requêtes que la
// promesse est libellée, et un rappel de trop en vaut deux sur l'écran Interclub, qui recharge
// la liste ET le détail.
//
// Horloge simulée : le seuil est une durée, et une durée qu'on mesure sur l'horloge réelle
// rend un test lent ou instable, au choix.

// Typé par son implémentation : `vi.fn()` nu rend un mock trop large pour `onForeground`.
const espion = () => vi.fn(() => {});
let cb: ReturnType<typeof espion>;
let desabonner: () => void;

/** Force `document.visibilityState`, que jsdom expose en lecture seule. */
function visibilite(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibilite("visible");
  cb = espion();
  desabonner = onForeground(cb);
});

afterEach(() => {
  desabonner();
  vi.useRealTimers();
});

describe("onForeground", () => {
  it("n'appelle QU'UNE FOIS sur la rafale d'un même retour", () => {
    // Le défaut d'origine, et la raison d'être du module : un retour d'onglet déclenche souvent
    // `focus` ET `visibilitychange` à quelques millisecondes d'écart. Chaque écran repartait
    // donc en double — quatre requêtes sur l'écran Interclub, là où deux suffisaient.
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ne rappelle rien quand l'appli PART en arrière-plan", () => {
    // `visibilitychange` se déclenche dans les deux sens. Sans le contrôle de `visibilityState`,
    // quitter l'appli déclencherait un rechargement — exactement le contraire du but.
    visibilite("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("rappelle sur `pageshow` seul — le retour par « précédent » ne rejoue pas les deux autres", () => {
    // Le bfcache restaure la page telle quelle, sans `focus` ni `visibilitychange` : sans cet
    // écouteur, l'écran restait affiché avec un score périmé, et rien ne le rafraîchissait.
    window.dispatchEvent(new Event("pageshow"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("laisse passer DEUX retours distincts : le dédoublonnage ne doit rien avaler", () => {
    // Le pendant du premier test, et il compte autant : un seuil qui absorbe la rafale doit
    // rester très en deçà d'un aller-retour humain. Un dédoublonnage trop large ne se verrait
    // pas — l'écran resterait simplement périmé, sans erreur.
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_500);
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("tient le seuil de 1,5 s À LA MILLISECONDE PRÈS", () => {
    // La valeur est annoncée dans l'en-tête du module ; un chiffre qu'aucun test ne mesure finit
    // toujours par décrire une autre version du code.
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(1_499);
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(1); // encore dans la rafale

    vi.advanceTimersByTime(1);
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(2); // le seuil est atteint
  });

  it("accepte un seuil sur mesure, et le fait RESPECTER", () => {
    // La première version de ce test n'attendait que les deux appels après 100 ms : elle passait
    // aussi bien SANS le dédoublonnage, donc ne mesurait rien. Le contrôle par mutation l'a dit.
    // Ce qui compte, c'est l'appel qui n'a PAS lieu avant le seuil.
    const autre = espion();
    const stop = onForeground(autre, 100);
    try {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(99);
      window.dispatchEvent(new Event("focus"));
      expect(autre).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      window.dispatchEvent(new Event("focus"));
      expect(autre).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("désabonne LES TROIS écouteurs, et pas seulement celui qu'on a en tête", () => {
    // Un écouteur oublié survit au démontage du composant : il rappelle une fonction qui vise
    // un état disparu, et il le fait à chaque retour au premier plan, indéfiniment. C'est la
    // fuite que `useEffect` existe pour éviter, et elle ne se voit dans aucun écran.
    desabonner();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(5_000);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("pageshow"));
    expect(cb).not.toHaveBeenCalled();
  });
});
