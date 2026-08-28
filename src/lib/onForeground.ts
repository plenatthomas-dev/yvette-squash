// « L'utilisateur revient sur l'appli » — un seul rappel, pas trois.
//
// POURQUOI CE MODULE EXISTE
// Plusieurs écrans veulent se rafraîchir au retour au premier plan, et s'abonnaient chacun aux
// DEUX événements qui l'expriment :
//
//   window.addEventListener("focus", onFocus);
//   document.addEventListener("visibilitychange", onFocus);
//
// Or un retour d'onglet les déclenche souvent tous les deux, à quelques millisecondes d'écart.
// Chaque écran repartait donc en DOUBLE — et l'écran Interclub, qui recharge la liste ET le
// détail de la rencontre ouverte, émettait quatre requêtes là où deux suffisaient. Sur Neon,
// chacune paie au minimum une lecture de session, et le compute reste éveillé d'autant.
//
// `pageshow` est écouté en plus : un retour par le bouton « précédent » restaure la page depuis
// le bfcache SANS rejouer `focus` ni `visibilitychange`, et l'écran restait alors périmé.

/**
 * Appelle `cb` quand l'appli redevient visible, au plus une fois par `minGapMs`.
 *
 * Renvoie la fonction de désabonnement, à rendre telle quelle depuis un `useEffect`.
 *
 * Le seuil par défaut (1,5 s) est choisi pour absorber la rafale d'événements d'un même retour
 * sans jamais avaler deux retours distincts : personne ne quitte l'appli et n'y revient en
 * moins d'une seconde et demie, alors que `focus` et `visibilitychange` se suivent, eux, en
 * quelques millisecondes.
 */
export function onForeground(cb: () => void, minGapMs = 1500): () => void {
  if (typeof window === "undefined") return () => {};

  let last = 0;
  const fire = () => {
    // `visibilitychange` se déclenche AUSSI au passage en arrière-plan : on ne rafraîchit que
    // dans le sens qui nous intéresse.
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - last < minGapMs) return;
    last = now;
    cb();
  };

  window.addEventListener("focus", fire);
  document.addEventListener("visibilitychange", fire);
  window.addEventListener("pageshow", fire);
  return () => {
    window.removeEventListener("focus", fire);
    document.removeEventListener("visibilitychange", fire);
    window.removeEventListener("pageshow", fire);
  };
}
